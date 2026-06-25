import { releaseUtils } from './release-utils.mjs';

releaseUtils.runCommand('pnpm', ['exec', 'changeset', 'version']);
