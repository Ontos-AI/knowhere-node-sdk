#!/usr/bin/env node
import { runKnowhereMcpServer } from './index.js';

runKnowhereMcpServer().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
