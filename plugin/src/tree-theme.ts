/**
 * Tree theme switching and persistence.
 *
 * `treeTheme` is a plugin option in an OpenCode config file
 * (`plugins[].options.treeTheme`). The palette command flips it at runtime and
 * writes the same value back to the config that supplies the plugin entry, so
 * the choice survives a restart without touching any other setting.
 *
 * OpenCode has no plugin API for rewriting arbitrary config options, so this
 * module edits the JSON/JSONC document directly. The editor is token-based:
 * only the matching entry's `options` object (or a string entry) is replaced,
 * leaving comments, formatting, and unrelated keys untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeBarStyle,
  normalizeTreeTheme,
  type BarStyle,
  type TreeTheme,
} from "./tree.js";

export interface ThemeOptions {
  treeTheme?: TreeTheme;
  barStyle?: BarStyle;
}

export interface ThemeWriteResult {
  ok: boolean;
  treeTheme?: TreeTheme;
  barStyle?: BarStyle;
  /** Config file that received the change, when one was found. */
  file?: string;
  /** Why nothing was written; the theme still applies to this run. */
  error?: string;
}

export interface TreeThemeWriteResult {
  ok: boolean;
  theme: TreeTheme;
  /** Config file that received the change, when one was found. */
  file?: string;
  /** Why nothing was written; the theme still applies to this run. */
  error?: string;
}

export interface TreeThemeWriteOptions {
  /** Project directory whose `opencode.json` wins over the global config. */
  directory?: string;
  /** Environment override, mainly for tests. */
  env?: NodeJS.ProcessEnv;
}

const PROGRESS_PLUGIN_NAME = "@jakedowns/progress-tool-opencode-plugin";

/** Global OpenCode config directory (`~/.config/opencode` by default). */
export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdg, "opencode");
}

/**
 * Config files in precedence order: project before global, `.json` before
 * `.jsonc`. Missing files are filtered by the caller.
 */
export function treeThemeConfigCandidates(
  directory?: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const candidates: string[] = [];
  if (directory) {
    candidates.push(path.join(directory, "opencode.json"));
    candidates.push(path.join(directory, "opencode.jsonc"));
  }
  const global = globalConfigDir(env);
  candidates.push(path.join(global, "opencode.json"));
  candidates.push(path.join(global, "opencode.jsonc"));
  return [...new Set(candidates)];
}

/**
 * True for a config plugin reference that points at this plugin: the published
 * package (with or without a version tag) or a local path whose package.json
 * names the plugin.
 */
export function isProgressPluginPackage(
  ref: unknown,
  baseDir: string = process.cwd()
): boolean {
  if (typeof ref !== "string" || !ref.trim()) return false;
  if (ref.includes("progress-tool-opencode-plugin")) return true;
  if (ref.startsWith(".") || path.isAbsolute(ref)) {
    const dir = path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      return pkg?.name === PROGRESS_PLUGIN_NAME;
    } catch {
      return false;
    }
  }
  return false;
}

// --- Minimal JSONC tokenizer / parser -------------------------------------

type Token =
  | { type: "punct"; value: string; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  | { type: "literal"; value: string; start: number; end: number };

interface Node {
  kind: "object" | "array" | "string" | "literal";
  start: number;
  end: number;
  value?: string;
  members?: Member[];
  items?: Node[];
}

interface Member {
  key: string;
  value: Node;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isDelimiter(ch: string): boolean {
  return (
    isWhitespace(ch) ||
    ch === "{" ||
    ch === "}" ||
    ch === "[" ||
    ch === "]" ||
    ch === ":" ||
    ch === "," ||
    ch === '"'
  );
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const length = input.length;
  let i = 0;

  while (i < length) {
    const ch = input[i];
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < length && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i = Math.min(length, i + 2);
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let value = "";
      while (i < length) {
        const c = input[i];
        if (c === "\\") {
          const esc = input[i + 1];
          if (esc === '"' || esc === "\\" || esc === "/") {
            value += esc;
            i += 2;
          } else if (esc === "b") {
            value += "\b";
            i += 2;
          } else if (esc === "f") {
            value += "\f";
            i += 2;
          } else if (esc === "n") {
            value += "\n";
            i += 2;
          } else if (esc === "r") {
            value += "\r";
            i += 2;
          } else if (esc === "t") {
            value += "\t";
            i += 2;
          } else if (esc === "u") {
            value += String.fromCharCode(parseInt(input.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += esc ?? "";
            i += 2;
          }
        } else if (c === '"') {
          i += 1;
          break;
        } else {
          value += c;
          i += 1;
        }
      }
      tokens.push({ type: "string", value, start, end: i });
      continue;
    }
    if ("{}[]:,".includes(ch)) {
      tokens.push({ type: "punct", value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    const start = i;
    while (i < length) {
      if (isDelimiter(input[i])) break;
      if (input[i] === "/" && (input[i + 1] === "/" || input[i + 1] === "*")) break;
      i += 1;
    }
    if (i === start) {
      // Unknown character (invalid JSONC); consume so tokenizing terminates.
      i += 1;
      continue;
    }
    tokens.push({ type: "literal", value: input.slice(start, i), start, end: i });
  }

  return tokens;
}

function parseValue(tokens: Token[], index: number): { node: Node; next: number } {
  const token = tokens[index];
  if (!token) throw new Error("unexpected end of config");

  if (token.type === "punct" && token.value === "{") {
    const members: Member[] = [];
    let i = index + 1;
    while (i < tokens.length) {
      const next = tokens[i];
      if (next.type === "punct" && next.value === "}") {
        i += 1;
        return { node: { kind: "object", start: token.start, end: next.end, members }, next: i };
      }
      if (next.type !== "string") throw new Error("expected an object key");
      const key = next.value;
      i += 1;
      if (!(tokens[i]?.type === "punct" && tokens[i].value === ":")) {
        throw new Error("expected ':'");
      }
      i += 1;
      const parsed = parseValue(tokens, i);
      members.push({ key, value: parsed.node });
      i = parsed.next;
      if (tokens[i]?.type === "punct" && tokens[i].value === ",") i += 1;
    }
    throw new Error("unterminated object");
  }

  if (token.type === "punct" && token.value === "[") {
    const items: Node[] = [];
    let i = index + 1;
    while (i < tokens.length) {
      const next = tokens[i];
      if (next.type === "punct" && next.value === "]") {
        i += 1;
        return { node: { kind: "array", start: token.start, end: next.end, items }, next: i };
      }
      const parsed = parseValue(tokens, i);
      items.push(parsed.node);
      i = parsed.next;
      if (tokens[i]?.type === "punct" && tokens[i].value === ",") i += 1;
    }
    throw new Error("unterminated array");
  }

  if (token.type === "string") {
    return {
      node: {
        kind: "string",
        start: token.start,
        end: token.end,
        value: token.value,
      },
      next: index + 1,
    };
  }

  if (token.type === "literal") {
    return {
      node: { kind: "literal", start: token.start, end: token.end, value: token.value },
      next: index + 1,
    };
  }

  throw new Error("unexpected token");
}

function memberOf(node: Node, key: string): Member | undefined {
  return node.members?.find((member) => member.key === key);
}

function pluginRefOf(node: Node): unknown {
  if (node.kind === "string") return node.value;
  if (node.kind !== "object") return undefined;
  const pkg = memberOf(node, "package");
  return pkg?.value.kind === "string" ? pkg.value.value : undefined;
}

/**
 * Insert a property into an object without disturbing its formatting.
 * Reuses a trailing comma when present and otherwise adds one.
 */
function insertObjectProperty(
  text: string,
  node: Node,
  property: string,
  value: string
): string {
  const object = node as Node;
  const close = object.end - 1; // index of the closing `}`
  let cursor = close;
  while (cursor > object.start && isWhitespace(text[cursor - 1])) cursor -= 1;
  const hasMembers = (object.members?.length ?? 0) > 0;
  const trailingComma = cursor > object.start && text[cursor - 1] === ",";
  const prefix = trailingComma ? " " : hasMembers ? ", " : "";
  const insert = `${prefix}${JSON.stringify(property)}: ${value}`;
  return text.slice(0, cursor) + insert + text.slice(cursor);
}

function replaceSpan(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function writePropertyIntoEntry(
  text: string,
  key: string,
  literal: string,
  entry: Node
): string | undefined {
  const options = memberOf(entry, "options");

  if (options?.value.kind === "object") {
    const current = memberOf(options.value, key);
    if (current) {
      return replaceSpan(text, current.value.start, current.value.end, literal);
    }
    return insertObjectProperty(text, options.value, key, literal);
  }

  // A missing or non-object `options` is replaced wholesale so the plugin
  // entry cannot keep an invalid value beside the new settings.
  if (options) {
    return replaceSpan(
      text,
      options.value.start,
      options.value.end,
      `{ ${JSON.stringify(key)}: ${literal} }`
    );
  }

  return insertObjectProperty(text, entry, "options", `{ ${JSON.stringify(key)}: ${literal} }`);
}

function setThemePropertyInConfig(
  text: string,
  key: string,
  value: string,
  options: TreeThemeEditOptions
): string | undefined {
  let root: Node;
  try {
    const parsed = parseValue(tokenize(text), 0);
    root = parsed.node;
  } catch {
    return undefined;
  }
  if (root.kind !== "object") return undefined;

  const plugins = memberOf(root, "plugins");
  if (!plugins || plugins.value.kind !== "array" || !plugins.value.items) return undefined;

  for (const item of plugins.value.items) {
    const ref = pluginRefOf(item);
    if (typeof ref !== "string" || !options.matches(ref)) continue;

    if (item.kind === "object") {
      return writePropertyIntoEntry(text, key, JSON.stringify(value), item);
    }
    if (item.kind === "string") {
      // Convert the shorthand string entry into the object form so it can hold
      // options, keeping the original package string.
      return replaceSpan(
        text,
        item.start,
        item.end,
        `{ "package": ${JSON.stringify(item.value ?? "")}, "options": { ${JSON.stringify(key)}: ${JSON.stringify(value)} } }`
      );
    }
  }

  return undefined;
}

export interface TreeThemeEditOptions {
  /** Called with each plugin reference found in `plugins`. */
  matches: (ref: string) => boolean;
}

/**
 * Rewrite a JSON/JSONC config document so the progress plugin entry stores the
 * supplied theme settings. Only the keys present in `theme` are changed, so a
 * caller can update `treeTheme` without disturbing `barStyle` (or vice versa).
 * Returns `undefined` when no matching entry exists (or the document is not a
 * config object), so callers can try the next file.
 */
export function updateThemeInConfig(
  text: string,
  theme: ThemeOptions,
  options: TreeThemeEditOptions
): string | undefined {
  if (text.charCodeAt(0) === 0xfeff) {
    const updated = updateThemeInConfig(text.slice(1), theme, options);
    return updated === undefined ? undefined : `\uFEFF${updated}`;
  }

  const settings: Array<[string, string]> = [];
  if (theme.treeTheme !== undefined) {
    settings.push(["treeTheme", normalizeTreeTheme(theme.treeTheme)]);
  }
  if (theme.barStyle !== undefined) {
    settings.push(["barStyle", normalizeBarStyle(theme.barStyle)]);
  }
  if (settings.length === 0) return text;

  let updated = text;
  for (const [key, value] of settings) {
    const next = setThemePropertyInConfig(updated, key, value, options);
    if (next === undefined) return undefined;
    updated = next;
  }
  return updated;
}

/** Backwards-compatible wrapper for callers that only change `treeTheme`. */
export function updateTreeThemeInConfig(
  text: string,
  theme: TreeTheme,
  options: TreeThemeEditOptions
): string | undefined {
  return updateThemeInConfig(text, { treeTheme: theme }, options);
}

function atomicWrite(file: string, body: string): void {
  const stat = fs.statSync(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: "utf8", mode: stat.mode });
  fs.renameSync(tmp, file);
}

/**
 * Find the config that declares this plugin and store the supplied theme
 * settings there. Project config wins over the global one; the first matching
 * document is edited. The runtime theme applies even when this returns
 * `ok: false`. Keys absent from `values` are left untouched.
 */
export function writeThemeToConfig(
  values: ThemeOptions,
  options: TreeThemeWriteOptions = {}
): ThemeWriteResult {
  const theme: ThemeOptions = {};
  if (values.treeTheme !== undefined) {
    theme.treeTheme = normalizeTreeTheme(values.treeTheme);
  }
  if (values.barStyle !== undefined) {
    theme.barStyle = normalizeBarStyle(values.barStyle);
  }
  if (theme.treeTheme === undefined && theme.barStyle === undefined) {
    return { ok: false, error: "no theme values supplied" };
  }

  const env = options.env ?? process.env;
  const candidates = treeThemeConfigCandidates(options.directory, env);

  for (const file of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const updated = updateThemeInConfig(text, theme, {
      matches: (ref) => isProgressPluginPackage(ref, path.dirname(file)),
    });
    if (updated === undefined) continue;
    try {
      if (updated !== text) atomicWrite(file, updated);
      return { ok: true, ...theme, file };
    } catch (error) {
      return { ok: false, ...theme, file, error: String(error) };
    }
  }

  return {
    ok: false,
    ...theme,
    error: "no OpenCode config entry found for this plugin",
  };
}

/** Backwards-compatible wrapper for callers that only change `treeTheme`. */
export function writeTreeThemeToConfig(
  value: unknown,
  options: TreeThemeWriteOptions = {}
): TreeThemeWriteResult {
  const theme = normalizeTreeTheme(value);
  const result = writeThemeToConfig({ treeTheme: theme }, options);
  return {
    ok: result.ok,
    theme,
    file: result.file,
    error: result.error,
  };
}
