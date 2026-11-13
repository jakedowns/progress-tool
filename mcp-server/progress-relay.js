#!/usr/bin/env node
'use strict';

// Thin alias so `progress-relay` can be used directly from any shell or
// harness without knowing that the implementation lives next to the MCP
// server. The real contract lives in relay.js and docs/out-of-band-relay-spec.md.

require('./relay').main(process.argv.slice(2), 'relay');
