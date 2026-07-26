/**
 * Fixed default port so external clients (MCP config, CLI tools) can point
 * at a stable address. Overridable via the `localApiPort` setting.
 */
export const DEFAULT_LOCAL_API_PORT = 4517

/**
 * Variants ×N (§6.6): how many parallel generations one node may claim in a
 * single run. Deliberately small — each variant is a full queue slot and a full
 * credit charge; the grid compare is built for 2–4 candidates side by side.
 */
export const MAX_VARIANTS = 4
