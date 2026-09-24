// Baked into the gateway image at /srv/<front>/assets/ alongside placeholder/index.html — exists
// solely so tests/gateway can exercise the real (not just 404) /assets/ response: a hashed-style
// build asset that actually exists, served with the long, immutable cache lifetime. Overwritten
// the moment a later frontend plan bind-mounts its own dist/ over /srv/<front>.
export {};
