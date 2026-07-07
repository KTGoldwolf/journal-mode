import {
  App,
  Editor,
  FuzzySuggestModal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { SyntaxNode, Tree } from "@lezer/common";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/* WASHI TAPES */

/**
 * A washi divider is a fenced ```washi block whose body names a tape style.
 * Each style is a CSS class (`.jm-washi--<id>`); 
 *
 * This picker discovers every
 * `.jm-washi--<id>` 
 * defined in CSS.
 */
interface WashiTape {
  id: string;
  name: string;
}

/* TEXT: COLORS */
const COLOR_PATTERN = "\\{([a-zA-Z][a-zA-Z0-9 _-]*):[ ]?([^{}\\n]*?)\\}";
/* Special reserved keyword to use every defined color in order. */
const RAINBOW_NAME = "rainbow";

type ResolvedColor =
  | { rainbow: false; hex: string }
  | { rainbow: true; colors: string[] };

/* TEXT: ANIMATION */
const MOTIONS = ["shiver", "shake", "rage", "shock", "wave"];
const MOTION_SET = new Set(MOTIONS);

interface TagSpec {
  color: ResolvedColor | null;
  motion: string | null;
  sparkle: boolean;
}

/** Muted, journal-friendly defaults. Override per-name in settings. */
const DEFAULT_PALETTE: Record<string, string> = {
  red: "#c0392b",
  orange: "#ca6a2e",
  gold: "#b8902b",
  green: "#3f7d4f",
  sea: "#2f7e7e",
  blue: "#3a6ea5",
  violet: "#7a5ba6",
  gray: "#6b6b6b",
};

/* SETTINGS */
interface JournalModeSettings {
  palette: Record<string, string>;
  hideTagsInEditMode: boolean;
}

const DEFAULT_SETTINGS: JournalModeSettings = {
  palette: { ...DEFAULT_PALETTE },
  hideTagsInEditMode: true,
};

export default class JournalModePlugin extends Plugin {
  settings: JournalModeSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "color-selection",
      name: "Color selected text",
      editorCallback: (editor) => this.openColorPicker(editor),
    });

    this.addCommand({
      id: "animate-selection",
      name: "Animate selected text",
      editorCallback: (editor) => this.openMotionPicker(editor),
    });

    this.addCommand({
      id: "insert-washi-divider",
      name: "Insert washi divider",
      editorCallback: (editor) => this.openWashiPicker(editor),
    });

    // Render ```washi blocks as tape dividers (both reading view and Live Preview).
    this.registerMarkdownCodeBlockProcessor("washi", (source, el) => {
      const name = (source.trim().split(/\s+/)[0] || "tape").toLowerCase();
      const safe = name.replace(/[^a-z0-9-]/g, "") || "tape";
      const tape = el.createDiv({ cls: ["jm-washi", `jm-washi--${safe}`] });
      tape.setAttr("role", "separator");
      tape.setAttr("aria-label", `washi divider: ${safe}`);
    });

    // Reading view: turn `{name: text}` into a colored span.
    this.registerMarkdownPostProcessor((el) => this.colorizeReadingView(el));

    // Live Preview / Source: color `{name: text}` while typing.
    this.registerEditorExtension(colorEditorExtension(this));

    this.addSettingTab(new JournalModeSettingTab(this.app, this));
  }

  resolveColor(name: string): ResolvedColor | null {
    const lower = name.toLowerCase();
    if (lower === RAINBOW_NAME) {
      const colors = Object.values(this.settings.palette);
      return colors.length ? { rainbow: true, colors } : null;
    }
    const hex = this.settings.palette[lower];
    return hex ? { rainbow: false, hex } : null;
  }

  parseTag(raw: string): TagSpec | null {
    const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    let color: ResolvedColor | null = null;
    let motion: string | null = null;
    let sparkle = false;
    for (const token of tokens) {
      if (token === "sparkle") {
        sparkle = true;
        continue;
      }
      if (MOTION_SET.has(token)) {
        motion = token;
        continue;
      }
      const resolved = this.resolveColor(token);
      if (resolved) {
        color = resolved;
        continue;
      }
      return null;
    }
    return color || motion || sparkle ? { color, motion, sparkle } : null;
  }

  private wrapSelectionInTag(editor: Editor, tag: string) {
    const selection = editor.getSelection();
    if (selection) {
      editor.replaceSelection(`{${tag}: ${selection}}`);
    } else {
      const cursor = editor.getCursor();
      const template = `{${tag}: }`;
      editor.replaceRange(template, cursor);
      editor.setCursor({ line: cursor.line, ch: cursor.ch + template.length - 1 });
    }
  }

  openColorPicker(editor: Editor) {
    const names = [RAINBOW_NAME, ...Object.keys(this.settings.palette)];
    if (names.length <= 1) {
      new Notice("No colors defined. Add some in Journal Mode settings.");
      return;
    }
    new StringSuggestModal(this.app, names, "Pick a color…", (name) =>
      this.wrapSelectionInTag(editor, name)
    ).open();
  }

  openMotionPicker(editor: Editor) {
    new StringSuggestModal(this.app, [...MOTIONS, "sparkle"], "Pick an animation…", (motion) =>
      this.wrapSelectionInTag(editor, motion)
    ).open();
  }

  openWashiPicker(editor: Editor) {
    new WashiPickerModal(this.app, availableTapes(), (tape) => {
      editor.replaceSelection(`\n\`\`\`washi\n${tape.id}\n\`\`\`\n`);
    }).open();
  }

  private colorizeReadingView(root: HTMLElement) {
    const doc = root.ownerDocument;
    const re = new RegExp(COLOR_PATTERN, "g");
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue || node.nodeValue.indexOf("{") === -1) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest("code, pre, .jm-color")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) textNodes.push(current as Text);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue ?? "";
      re.lastIndex = 0;
      const frag = doc.createDocumentFragment();
      let lastIndex = 0;
      let changed = false;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        const spec = this.parseTag(match[1]);
        if (!spec) continue; // unknown tag: leave it as written
        changed = true;
        if (match.index > lastIndex) {
          frag.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
        }
        appendStyledContent(frag, match[2], spec, doc);
        lastIndex = match.index + match[0].length;
      }
      if (changed) {
        if (lastIndex < text.length) {
          frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
        }
        textNode.replaceWith(frag);
      }
    }
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<JournalModeSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!this.settings.palette || !Object.keys(this.settings.palette).length) {
      this.settings.palette = { ...DEFAULT_PALETTE };
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshEditors();
  }

  private refreshEditors() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = (leaf.view as { editor?: { cm?: EditorView } }).editor?.cm;
      if (cm) cm.dispatch({ effects: refreshTagsEffect.of(null) });
    });
  }
}

/* Preview styles in edit mode */
function colorEditorExtension(plugin: JournalModePlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshTagsEffect))
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || refreshed) {
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const tree = syntaxTree(view.state);
        const re = new RegExp(COLOR_PATTERN, "g");

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          re.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = re.exec(text))) {
            const spec = plugin.parseTag(match[1]);
            if (!spec) continue;

            const start = from + match.index;
            if (isInsideCode(tree, start)) continue;

            const end = start + match[0].length;
            const contentStart = end - match[2].length - 1;
            const contentEnd = contentStart + match[2].length;

            // Users can pick if they want to hide or show empty JM style tags
            const empty = match[2].trim() === "";
            const hide =
              plugin.settings.hideTagsInEditMode && !empty && !cursorInside(view, start, end);
            const delim = hide ? HIDDEN_DELIM : DELIM_DECORATION;

            builder.add(start, contentStart, delim);
            const perLetter =
              spec.motion !== null || spec.sparkle || spec.color?.rainbow === true;
            if (perLetter) {
              let i = 0;
              let offset = contentStart;
              for (const ch of match[2]) {
                if (!/\s/.test(ch)) {
                  builder.add(offset, offset + ch.length, letterMark(spec, i));
                  i++;
                }
                offset += ch.length;
              }
            } else if (contentEnd > contentStart && spec.color && !spec.color.rainbow) {
              builder.add(contentStart, contentEnd, colorMark(spec.color.hex));
            }
            builder.add(contentEnd, end, delim);
          }
        }

        return builder.finish();
      }
    },
    { decorations: (value) => value.decorations }
  );
}

const DELIM_DECORATION = Decoration.mark({ class: "jm-color-delim" });
const HIDDEN_DELIM = Decoration.replace({});

const refreshTagsEffect = StateEffect.define<null>();
function cursorInside(view: EditorView, from: number, to: number): boolean {
  return view.state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

const colorMarkCache = new Map<string, Decoration>();
function colorMark(hex: string): Decoration {
  let deco = colorMarkCache.get(hex);
  if (!deco) {
    deco = Decoration.mark({ class: "jm-color", attributes: { style: `color:${hex}` } });
    colorMarkCache.set(hex, deco);
  }
  return deco;
}

function letterMark(spec: TagSpec, i: number): Decoration {
  const { className, style } = letterStyle(spec, i);
  return Decoration.mark({ class: className, attributes: { style } });
}

function letterStyle(spec: TagSpec, i: number): { className: string; style: string } {
  const classes: string[] = [];
  const styles: string[] = [];
  if (spec.color) {
    classes.push("jm-color");
    const hex = spec.color.rainbow ? spec.color.colors[i % spec.color.colors.length] : spec.color.hex;
    styles.push(`color:${hex}`);
  }
  if (spec.motion) {
    classes.push("jm-motion", `jm-motion--${spec.motion}`);
    styles.push(`animation-delay:${motionDelay(spec.motion, i)}`);
  }
  if (spec.sparkle) {
    classes.push("jm-sparkle");
    styles.push(`--jm-sparkle-delay:-${sparkleHash(i, 1) % 1400}ms`);
    styles.push(`--jm-sparkle-dur:${1100 + (sparkleHash(i, 2) % 800)}ms`);
  }
  return { className: classes.join(" "), style: styles.join(";") };
}

// Randomize sparkles so it looks less mechanical
function sparkleHash(i: number, salt: number): number {
  let x = Math.imul(i + 1, 374761393) ^ Math.imul(salt, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return x >>> 0;
}

function motionDelay(motion: string, i: number): string {
  if (motion === "wave") return `-${i * 120}ms`;
  return `-${(i % 6) * 50}ms`;
}

function colorSpan(doc: Document, text: string, hex: string): HTMLSpanElement {
  const span = doc.createElement("span");
  span.className = "jm-color";
  span.style.color = hex;
  span.textContent = text;
  return span;
}

function appendStyledContent(frag: DocumentFragment, content: string, spec: TagSpec, doc: Document) {
  const perLetter = spec.motion !== null || spec.sparkle || spec.color?.rainbow === true;
  if (!perLetter) {
    if (spec.color && !spec.color.rainbow) frag.appendChild(colorSpan(doc, content, spec.color.hex));
    else frag.appendChild(doc.createTextNode(content));
    return;
  }
  let i = 0;
  for (const ch of content) {
    if (/\s/.test(ch)) {
      frag.appendChild(doc.createTextNode(ch));
      continue;
    }
    const { className, style } = letterStyle(spec, i);
    const span = doc.createElement("span");
    span.className = className;
    span.style.cssText = style;
    span.textContent = ch;
    frag.appendChild(span);
    i++;
  }
}

function isInsideCode(tree: Tree, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (/code/i.test(node.type.name)) return true;
    node = node.parent;
  }
  return false;
}

function prettify(id: string): string {
  const text = id.replace(/-/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function scanStylesheets(re: RegExp): Set<string> {
  const found = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule instanceof CSSStyleRule) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(rule.selectorText))) found.add(m[1].toLowerCase());
      } else if ("cssRules" in rule) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (let i = 0; i < activeDocument.styleSheets.length; i++) {
    try {
      walk(activeDocument.styleSheets[i].cssRules);
    } catch {
      // Skip cross site origin CSS sheets silently
    }
  }
  return found;
}

function availableTapes(): WashiTape[] {
  return Array.from(scanStylesheets(/\.jm-washi--([a-z0-9-]+)/gi))
    .filter((id) => id !== "tape")
    .sort()
    .map((id) => ({ id, name: prettify(id) }));
}

class WashiPickerModal extends FuzzySuggestModal<WashiTape> {
  constructor(app: App, private tapes: WashiTape[], private onChoose: (tape: WashiTape) => void) {
    super(app);
    this.setPlaceholder("Pick a washi tape…");
  }

  getItems(): WashiTape[] {
    return this.tapes;
  }

  getItemText(item: WashiTape): string {
    return item.name;
  }

  onChooseItem(item: WashiTape): void {
    this.onChoose(item);
  }
}

class StringSuggestModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private items: string[],
    placeholder: string,
    private onChoose: (item: string) => void
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): string[] {
    return this.items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onChoose(item);
  }
}

class JournalModeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: JournalModePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Hide format tags in editing mode")
      .setDesc(
        "Hide the {tag: …} delimiters while editing, revealing them only when the " +
          "cursor is inside — like Markdown's ** markers."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideTagsInEditMode).onChange(async (value) => {
          this.plugin.settings.hideTagsInEditMode = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Colors").setHeading();

    new Setting(containerEl)
      .setName("Palette")
      .setDesc(
        "One color per line as `name #hex`. Use a name in a note like {sea: words}. " +
          "Unknown names are left as plain text."
      )
      .addTextArea((area) => {
        area.setValue(serializePalette(this.plugin.settings.palette));
        area.inputEl.rows = 8;
        area.inputEl.addClass("jm-palette-textarea");
        area.onChange(async (value) => {
          this.plugin.settings.palette = parsePalette(value);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Reset palette to defaults").onClick(async () => {
        this.plugin.settings.palette = { ...DEFAULT_PALETTE };
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}

function serializePalette(palette: Record<string, string>): string {
  return Object.entries(palette)
    .map(([name, hex]) => `${name} ${hex}`)
    .join("\n");
}

function parsePalette(text: string): Record<string, string> {
  const palette: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([a-zA-Z][\w-]*)\s*[:=]?\s*(#[0-9a-fA-F]{3,8})$/);
    if (match) palette[match[1].toLowerCase()] = match[2];
  }
  return palette;
}
