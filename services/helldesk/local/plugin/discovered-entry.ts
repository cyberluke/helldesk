/**
 * CyberLuke Local HELLDESK — discovered plugin shim.
 *
 * Kilo auto-discovers every `.ts` file in its user `plugin/` directory
 * (e.g. `~/.config/kilo/plugin/`). This shim re-exports the real plugin
 * factory from the repo so the two share one implementation.
 *
 * It is generated/copied by `services/helldesk/local/scripts/install-plugin.ps1`
 * and co-exists with the existing `clean-system-prompt.ts` (Kilo loads both by
 * distinct `id`). This module has NO side effects on import — `server` is a
 * function invoked per Kilo session.
 *
 * NOTE FOR THE LIVE HOST GATE: loading this plugin in a running Kilo process
 * is the last verification step left to the operator (a live VS Code host is
 * not available in the build sandbox). It registers only `tool` + `event`
 * hooks, so it cannot strip the `Hakakatoni Ultra` persona or the
 * `cyberluke-clean-system-prompt` plugin.
 */
import { LocalHelldeskPlugin } from '<REPO_PATH>/services/helldesk/local/plugin/index.ts';

export default {
  id: 'cyberluke-local-helldesk',
  server: LocalHelldeskPlugin,
};