// Ambient declaration so side-effect CSS imports (`import './globals.css'`)
// type-check on a fresh clone, before `next dev` generates next-env.d.ts.
// Harmless once Next's own types are present.
declare module '*.css'
