#!/usr/bin/env node
'use strict';

// One-shot milestone emitter for scripts that do not have a long-running
// stdout stream. Same state store, same fire-and-forget semantics.

require('./relay').main(process.argv.slice(2), 'emit');
