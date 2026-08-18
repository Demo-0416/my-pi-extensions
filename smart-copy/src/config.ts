/**
 * smart-copy 偏好持久化：~/.pi/agent/smart-copy.json。
 * pi 没有 settings API，插件自己读写（任务规格事实 6）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SmartCopyConfig {
  /** true 时 /copyx 跳过选择器，直接全量复制。 */
  alwaysFull?: boolean;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "smart-copy.json");

export function configPath(): string {
  return CONFIG_PATH;
}

export function readConfig(): SmartCopyConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as SmartCopyConfig;
    }
  } catch {
    // 文件不存在或 JSON 损坏 → 默认配置。
  }
  return {};
}

export function writeConfig(patch: SmartCopyConfig): void {
  const next = { ...readConfig(), ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
