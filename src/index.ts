/** 包入口:默认导出 `WorldDefinition`。 */
import { HEARTHSTONE } from './definition.ts';

export default HEARTHSTONE;

export { HEARTHSTONE };
export { HearthstoneWorld, HEARTHSTONE_TOOL_DECLS, HEARTHSTONE_DESCRIBE, FEEDBACK_EMAIL, type HearthstoneWorldOptions } from './world.ts';
export { HEARTHSTONE_DEFAULTS, HEARTHSTONE_ID, hearthstoneConfigGroups, type HearthstoneConfigSection } from './config.ts';
export { PowerLogParser, renderSnapshot, parseEntityRef, type GameSnapshot, type SideState } from './parser.ts';
export { PowerLogTail, resolvePowerLog, looksLikePowerLog, describeSearch } from './log-source.ts';
export { detectAlerts } from './alerts.ts';
