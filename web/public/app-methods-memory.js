(function attachHmAppMemoryMethods(globalObj) {
  function createMethods(H) {
    const from = (factory) => (typeof factory === 'function' ? factory(H) : {});
    return {
      ...from(globalObj.HmAppMemorySessionMethods?.createMethods),
      ...from(globalObj.HmAppMemoryLearnMethods?.createMethods),
      ...from(globalObj.HmAppMemoryRollbackMethods?.createMethods)
    };
  }

  globalObj.HmAppMemoryMethods = { createMethods };
}(window));
