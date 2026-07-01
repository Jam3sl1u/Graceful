// no-op mock — Next's webpack config aliases the real `server-only` package
// to a no-op in server bundles; Jest needs the same aliasing since it runs
// outside that bundler (see jest.config.ts moduleNameMapper).
