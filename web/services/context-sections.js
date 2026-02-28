function parseContextSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let currentSection = null;

  for (const line of lines) {
    if (line.startsWith('## MEMORY') || line.startsWith('## RECENT')) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: line.substring(3).trim(), content: '' };
      continue;
    }
    if (currentSection) {
      currentSection.content += `${line}\n`;
    }
  }
  if (currentSection) sections.push(currentSection);
  return sections;
}

module.exports = {
  parseContextSections
};
