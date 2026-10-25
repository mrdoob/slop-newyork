// 用 `node --import ./tools/hk-boot/register.mjs …` 掛上 loader hook
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
