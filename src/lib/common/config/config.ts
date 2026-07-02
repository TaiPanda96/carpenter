/**
 * Typed application config. Read env ONCE, here, so the rest of the app
 * depends on `config` (injected via ctx) rather than reaching into
 * process.env directly. Add fields here as the app needs them.
 */
export interface Config {
  nodeEnv: string
}

export const config: Config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
}
