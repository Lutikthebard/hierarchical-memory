#!/usr/bin/env node
/**
 * Context Generator for Hierarchical Memory
 * 
 * Generates context by algorithm from reference (memory-service.ts → getMemoryForPrompt):
 * - Top-down by levels
 * - Last contextOverlap artifacts are "expanded" (not summarized)
 * - Others shown as-is
 * 
 * Result: high-level summaries + recent details
 * 
 * Usage:
 *   node context.js generate <agentId> [--output CONTEXT.md]
 *   node context.js stats <agentId>
 */

const fs = require('fs');
const path = require('path');
const { clampArtifactsToParentRange } = require('../web/services/artifact-levels');
const {
    loadStore,
    loadConfig,
    loadAgentConfig,
    DEFAULT_AGENT_CONFIG,
    getDataDir,
    getArchivedMessages,
    getMessagesDir,
    filterForContext
} = require('./store');

/**
 * Format timestamp for display
 */
function formatTimestamp(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Format messages for context
 */
function formatMessages(messages, includeTimestamps) {
    return messages.map(msg => {
        const timestamp = includeTimestamps && msg.timestamp 
            ? `[${formatTimestamp(msg.timestamp)}] ` 
            : '';
        if (msg.messageClass === 'inter_agent' || msg.toolName === 'sessions_send') {
            const direction = msg.direction === 'outgoing'
                ? 'OUT'
                : msg.direction === 'result'
                    ? 'RESULT'
                    : 'EVENT';
            const target = msg.toSessionKey || msg.fromSessionKey || 'unknown';
            const status = msg.status ? ` status=${msg.status}` : '';
            const reason = msg.runId ? ` runId=${msg.runId}` : '';
            return `${timestamp}${direction} ${target}:${status}${reason}\n${msg.content}`;
        }

        const role = msg.role.toUpperCase();
        const content = msg.content;
        return `${timestamp}${role}: ${content}`;
    }).join('\n\n');
}

/**
 * Format artifacts for context
 */
function formatArtifacts(artifacts, includeTimestamps) {
    return artifacts.map(artifact => {
        const timeRange = includeTimestamps 
            ? `### ${formatTimestamp(artifact.startTimestamp)} → ${formatTimestamp(artifact.endTimestamp)}\n`
            : '';
        return `${timeRange}\n${artifact.content}`;
    }).join('\n\n---\n\n');
}

/**
 * Load recent archived messages for an agent (last N days).
 * Merges with store.messages, deduplicates by timestamp.
 * 
 * @param {string} agentId - Agent identifier
 * @param {Array} storeMessages - Current store.messages
 * @param {number} days - Number of past days to load (default 2)
 * @returns {Array} Merged & deduplicated messages sorted by timestamp
 */
function loadRecentMessages(agentId, storeMessages, days = 2) {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(now);
    endDate.setHours(23, 59, 59, 999);

    // Load archived messages for the date range
    let archivedMessages = [];
    try {
        archivedMessages = getArchivedMessages(
            agentId,
            startDate.toISOString(),
            endDate.toISOString()
        );
    } catch (e) {
        // No archived messages available
    }

    // Merge: archived + store, deduplicate by timestamp
    const byTimestamp = new Map();
    for (const msg of archivedMessages) {
        byTimestamp.set(msg.timestamp, msg);
    }
    for (const msg of storeMessages) {
        byTimestamp.set(msg.timestamp, msg); // store messages override archived
    }

    // Sort by timestamp ascending
    const merged = Array.from(byTimestamp.values());
    merged.sort((a, b) => {
        const t1 = new Date(a.timestamp).getTime();
        const t2 = new Date(b.timestamp).getTime();
        return t1 - t2;
    });

    return merged;
}

function parseOverlapCount(rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(0, Math.floor(parsed));
}

function toTimestampMs(value) {
    const ms = new Date(value || 0).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function sortArtifactsAsc(artifacts) {
    return [...artifacts].sort((a, b) => {
        const aEnd = toTimestampMs(a.endTimestamp) ?? 0;
        const bEnd = toTimestampMs(b.endTimestamp) ?? 0;
        if (aEnd !== bEnd) return aEnd - bEnd;
        const aStart = toTimestampMs(a.startTimestamp) ?? 0;
        const bStart = toTimestampMs(b.startTimestamp) ?? 0;
        return aStart - bStart;
    });
}

function sortMessagesAsc(messages) {
    return [...messages].sort((a, b) => {
        const t1 = toTimestampMs(a.timestamp) ?? 0;
        const t2 = toTimestampMs(b.timestamp) ?? 0;
        return t1 - t2;
    });
}

function artifactKey(artifact) {
    if (artifact.artifactId) return `artifact:${artifact.artifactId}`;
    return `artifact:${artifact.level || ''}:${artifact.startTimestamp || ''}:${artifact.endTimestamp || ''}:${artifact.content || ''}`;
}

function messageKey(message) {
    return `message:${message.timestamp || ''}:${message.role || ''}:${message.content || ''}`;
}

function uniqueItems(items, isMessageLevel) {
    const out = [];
    const seen = new Set();
    for (const item of items) {
        const key = isMessageLevel ? messageKey(item) : artifactKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function drilldownSourceItems({ agentId, sourceItems, sourceStoreMessages, sourceLevel, parentArtifact }) {
    if (!parentArtifact) return [];

    if (sourceLevel === 0) {
        const parentStart = toTimestampMs(parentArtifact.startTimestamp);
        const parentEnd = toTimestampMs(parentArtifact.endTimestamp);
        if (parentStart === null || parentEnd === null) return [];

        const rangedFromSource = sourceItems.filter((item) => {
            const ts = toTimestampMs(item.timestamp);
            return ts !== null && ts >= parentStart && ts <= parentEnd;
        });

        if (!agentId) return sortMessagesAsc(uniqueItems(rangedFromSource, true));

        const archived = getArchivedMessages(agentId, parentArtifact.startTimestamp, parentArtifact.endTimestamp);
        const rangedFromStore = sourceStoreMessages.filter((item) => {
            const ts = toTimestampMs(item.timestamp);
            return ts !== null && ts >= parentStart && ts <= parentEnd;
        });
        return sortMessagesAsc(uniqueItems([...archived, ...rangedFromStore, ...rangedFromSource], true));
    }

    return clampArtifactsToParentRange(sourceItems, parentArtifact);
}

/**
 * Generate context using reference algorithm
 * 
 * Algorithm:
 * - Top-down from maxLevel+1 to 1
 * - For each level, sourceLevel = level - 1
 * - Find boundary: what's already summarized (accounting for overlap)
 * - Take "recent" items with ID > lastSummarizedId
 * 
 * @param {Object} store - Memory store
 * @param {Object} config - Configuration
 * @param {string} [agentId] - Agent ID (needed to load archived messages)
 * @returns {string} Generated context
 */
function generateContext(store, config, agentId) {
    const context = [];
    const artifactLevels = Object.keys(store.artifacts).map(Number);
    const maxLevel = artifactLevels.length > 0 ? Math.max(...artifactLevels) : 0;
    const contextOverlap = parseOverlapCount(config.contextOverlap);
    const includeTimestamps = config.includeTimestamps !== false;
    const agentConfig = agentId
        ? loadAgentConfig(agentId)
        : { filters: { ...(DEFAULT_AGENT_CONFIG.filters || {}) } };

    // Debug info
    context.push(`# Memory Context`);
    context.push(`_Generated: ${new Date().toISOString()}_`);
    context.push(`_Max Level: ${maxLevel}, Overlap: ${contextOverlap}_`);
    context.push('');

    // Top-down: from maxLevel+1 to 1
    for (let level = maxLevel + 1; level >= 1; level--) {
        const sourceLevel = level - 1;
        const isMessageLevel = sourceLevel === 0;

        // Artifacts that summarize sourceLevel
        const summarizingArtifacts = sortArtifactsAsc(store.artifacts[level] || []);
        
        // Source items (messages or artifacts)
        // For L0 messages: merge store.messages with archived messages from last 2 days
        const sourceItemsRaw = isMessageLevel
            ? (agentId ? loadRecentMessages(agentId, store.messages, 2) : store.messages)
            : (store.artifacts[sourceLevel] || []).filter((artifact) => artifact.contextEligible !== false);
        const sourceItems = isMessageLevel ? sortMessagesAsc(sourceItemsRaw) : sortArtifactsAsc(sourceItemsRaw);

        if (sourceItems.length === 0) continue;

        // Unified overlap rule:
        // - Last N summarizing artifacts are replaced by their drilldown source items.
        // - Plus include new source items after all summarizing coverage.
        // - For artifact levels, hide last N source artifacts so they are always expanded below.
        const hiddenSummaries = contextOverlap > 0 ? summarizingArtifacts.slice(-contextOverlap) : [];
        const expandedItems = hiddenSummaries.flatMap((parentArtifact) =>
            drilldownSourceItems({
                agentId,
                sourceItems,
                sourceStoreMessages: store.messages,
                sourceLevel,
                parentArtifact
            })
        );

        let tailItems = [];
        if (summarizingArtifacts.length > 0) {
            const summaryEnds = summarizingArtifacts
                .map((artifact) => toTimestampMs(artifact.endTimestamp))
                .filter((ms) => ms !== null);
            const maxSummaryEnd = summaryEnds.length > 0 ? Math.max(...summaryEnds) : null;
            if (maxSummaryEnd !== null) {
                tailItems = sourceItems.filter((item) => {
                    const itemEnd = isMessageLevel
                        ? toTimestampMs(item.timestamp)
                        : toTimestampMs(item.endTimestamp);
                    return itemEnd !== null && itemEnd > maxSummaryEnd;
                });
            }
        }

        let recentItems;
        if (summarizingArtifacts.length === 0) {
            recentItems = sourceItems;
        } else {
            recentItems = uniqueItems([...expandedItems, ...tailItems], isMessageLevel);
            recentItems = isMessageLevel ? sortMessagesAsc(recentItems) : sortArtifactsAsc(recentItems);
        }

        if (!isMessageLevel && contextOverlap > 0) {
            const hiddenSource = sourceItems.slice(-contextOverlap);
            const hiddenKeys = new Set(hiddenSource.map((artifact) => artifactKey(artifact)));
            recentItems = recentItems.filter((artifact) => !hiddenKeys.has(artifactKey(artifact)));
        }

        if (recentItems.length === 0) continue;

        // Format section
        if (isMessageLevel) {
            const filteredItems = filterForContext(recentItems, agentConfig);
            
            // Skip section if no messages left after filtering
            if (filteredItems.length === 0) continue;
            
            context.push('## RECENT CONVERSATION');
            const firstTs = formatTimestamp(filteredItems[0].timestamp);
            const lastTs = formatTimestamp(filteredItems[filteredItems.length - 1].timestamp);
            context.push(`_${filteredItems.length} messages (${firstTs} → ${lastTs})_`);
            context.push('');
            context.push(formatMessages(filteredItems, includeTimestamps));
        } else {
            context.push(`## MEMORY (LEVEL ${sourceLevel})`);
            const firstTs = formatTimestamp(recentItems[0].startTimestamp);
            const lastTs = formatTimestamp(recentItems[recentItems.length - 1].endTimestamp);
            context.push(`_${recentItems.length} artifacts (${firstTs} → ${lastTs})_`);
            context.push('');
            context.push(formatArtifacts(recentItems, includeTimestamps));
        }

        context.push('');
    }

    return context.join('\n');
}

/**
 * Get store statistics
 */
function getStats(store) {
    const stats = {
        messages: store.messages.length,
        artifacts: {}
    };

    for (const [level, artifacts] of Object.entries(store.artifacts)) {
        const arts = artifacts || [];
        if (arts.length === 0) {
            stats.artifacts[`L${level}`] = { count: 0, timeRange: 'N/A' };
            continue;
        }
        
        const timestamps = arts.map(a => ({
            start: new Date(a.startTimestamp).getTime(),
            end: new Date(a.endTimestamp).getTime()
        }));
        const minStart = Math.min(...timestamps.map(t => t.start));
        const maxEnd = Math.max(...timestamps.map(t => t.end));
        
        stats.artifacts[`L${level}`] = {
            count: arts.length,
            timeRange: `${formatTimestamp(new Date(minStart).toISOString())} → ${formatTimestamp(new Date(maxEnd).toISOString())}`
        };
    }

    return stats;
}

/**
 * Main CLI
 */
function main() {
    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        console.log('Usage:');
        console.log('  node context.js generate <agentId> [--output CONTEXT.md]');
        console.log('  node context.js stats <agentId>');
        console.log('');
        console.log('Examples:');
        console.log('  node context.js generate council-architect');
        console.log('  node context.js generate council-architect --output ../data/council-architect/CONTEXT.md');
        console.log('  node context.js stats council-architect');
        process.exit(1);
    }

    const command = args[0];
    const agentId = args[1];

    if (!agentId) {
        console.error('Error: agentId is required');
        process.exit(1);
    }

    const config = loadConfig();
    const store = loadStore(agentId);

    switch (command) {
        case 'generate': {
            const context = generateContext(store, config, agentId);
            
            // Check for --output flag
            const outputIndex = args.indexOf('--output');
            if (outputIndex !== -1 && args[outputIndex + 1]) {
                const outputPath = args[outputIndex + 1];
                const fullPath = path.resolve(process.cwd(), outputPath);
                
                // Ensure directory exists
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                
                fs.writeFileSync(fullPath, context, 'utf8');
                console.log(`Context written to: ${fullPath}`);
                console.log(`Size: ${context.length} bytes`);
            } else {
                console.log(context);
            }
            break;
        }

        case 'stats': {
            const stats = getStats(store);
            console.log('Store Statistics:');
            console.log(`  Messages: ${stats.messages}`);
            console.log(`  Next ID: ${stats.nextId}`);
            console.log('  Artifacts:');
            for (const [level, data] of Object.entries(stats.artifacts)) {
                console.log(`    ${level}: ${data.count} artifacts (IDs ${data.idRange})`);
            }
            break;
        }

        default:
            console.error(`Unknown command: ${command}`);
            process.exit(1);
    }
}

// Export for testing
module.exports = {
    generateContext,
    loadRecentMessages,
    formatMessages,
    formatArtifacts,
    getStats
};

// Run if called directly
if (require.main === module) {
    main();
}
