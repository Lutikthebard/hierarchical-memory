(function attachHmAppMethods(globalObj) {
  function createMethods(H) {
    const from = (factory) => (typeof factory === 'function' ? factory(H) : {});

    return {
      ...from(globalObj.HmAppDataMethods?.createMethods),
      ...from(globalObj.HmAppMemoryMethods?.createMethods),
      ...from(globalObj.HmAppAgentMethods?.createMethods)
    };
  }

  globalObj.HmAppMethods = {
    createMethods
  };
}(window));
