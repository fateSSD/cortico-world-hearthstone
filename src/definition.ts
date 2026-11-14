/**
 * 扩展入口:默认导出 `WorldDefinition`,装载器按 `cortico.kind === 'world'` 认它。
 */
import type { WorldDefinition } from 'cortico/world.ts';
import { HEARTHSTONE_DEFAULTS, HEARTHSTONE_ID, type HearthstoneConfigSection } from './config.ts';
import { HEARTHSTONE_DESCRIBE, HearthstoneWorld } from './world.ts';

export const HEARTHSTONE: WorldDefinition<HearthstoneConfigSection> = {
  id: HEARTHSTONE_ID,
  label: '炉石陪打',
  defaults: () => structuredClone(HEARTHSTONE_DEFAULTS()),

  // ctx.cfg 是 `worlds.hearthstone` 的活引用:热改的键现读即生效
  create: (ctx) => new HearthstoneWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botName: ctx.botName,
    dataDir: ctx.dataDir,
    secret: (name) => ctx.secret(name),
    persist: (patch) => ctx.persist(patch),
  }),

  describe: HEARTHSTONE_DESCRIBE,
};
