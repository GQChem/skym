import type { LaidOutNode, LayoutResult } from "./layout.js";
import { textWidth } from "./layout.js";
import type { Palette, Theme } from "./theme.js";
import { KIND_LABEL, STATE_GLYPH, inkFor } from "./theme.js";
import { DEFAULT_VOCAB, pulseStates } from "./vocab.js";

const DEFAULT_PULSE_STATES = pulseStates(DEFAULT_VOCAB);

export const esc = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface RenderOptions {
  theme: Theme;
  palette: Palette;
  /** Resolves a figure filename to a src the target document can load. */
  figureSrc: (file: string) => string;
  selectedId?: string | null;
  /** Offline export inlines figures and drops interaction affordances. */
  interactive?: boolean;
  /** Vocabulary lookups; default to the builtin template when absent. */
  glyphs?: Record<string, string>;
  kindLabels?: Record<string, string>;
  /** States drawn as in-flight; the stripe pulses for these. */
  pulseStates?: readonly string[];
}

function card(n: LaidOutNode, o: RenderOptions): string {
  const { theme, palette } = o;
  const { card: c, type } = theme;
  const ink = inkFor(palette, n.node.state);
  const selected = o.selectedId === n.id;
  const strokeW = selected ? c.selectedWidth : c.borderWidth;
  const stroke = selected ? palette.focus : ink.border;

  const parts: string[] = [];
  const pulse = (o.pulseStates ?? DEFAULT_PULSE_STATES).includes(n.node.state) ? " data-pulse=\"\"" : "";
  parts.push(
    `<g class="skym-node" data-id="${esc(n.id)}" data-state="${esc(n.node.state)}"${pulse} transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})">`,
  );

  parts.push(
    `<rect class="skym-card" width="${n.w}" height="${n.h.toFixed(1)}" rx="${c.radius}" ` +
      `fill="${ink.fill}" stroke="${stroke}" stroke-width="${strokeW}"/>`,
  );

  // The stripe is the state's loudest cue; it is clipped to the card radius.
  parts.push(
    `<path class="skym-stripe" d="${stripePath(n.h, c.radius, n.sideRail)}" fill="${ink.accent}"/>`,
  );

  const left = n.sideRail + c.padX;
  let y = c.padY;

  if (n.node.badge) {
    const badgeW = Math.max(24, textWidth(n.node.badge, 10, 700) + 14);
    parts.push(
      `<rect class="skym-badge" x="${left}" y="${y}" width="${badgeW.toFixed(1)}" height="20" rx="10" fill="${ink.accent}"/>`,
      `<text class="skym-badge-text" x="${(left + badgeW / 2).toFixed(1)}" y="${(y + 13.5).toFixed(1)}" ` +
        `fill="${contrastText(ink.accent)}" font-size="10" font-weight="700" text-anchor="middle">${esc(n.node.badge)}</text>`,
    );
    y += n.badgeHeight;
  }

  // Meta row: glyph + kind, the label pairing that lets colour stay in the
  // 6–8 CVD band legally.
  const glyph = (o.glyphs ?? STATE_GLYPH)[n.node.state] ?? "•";
  const kind = (o.kindLabels ?? KIND_LABEL)[n.node.kind] ?? n.node.kind;
  const typeLabel = n.presentation.typeLabel ?? "top";
  const stateLabel = n.presentation.stateLabel ?? "top";
  const topMeta = [typeLabel === "top" ? kind.toUpperCase() : "", stateLabel === "top" ? n.node.state.toUpperCase() : ""].filter(Boolean);
  const metaBaseline = y + type.metaSize;
  if (stateLabel === "top") {
    parts.push(
      `<text class="skym-glyph" x="${left}" y="${metaBaseline.toFixed(1)}" fill="${ink.accent}" ` +
        `font-size="${type.metaSize + 1.5}" font-weight="700">${esc(glyph)}</text>`,
    );
  }
  if (topMeta.length) parts.push(
    `<text class="skym-meta" x="${(stateLabel === "top" ? left + type.metaSize + 5 : left).toFixed(1)}" y="${metaBaseline.toFixed(1)}" ` +
      `fill="${palette.inkMuted}" font-size="${type.metaSize}" font-weight="${type.metaWeight}" ` +
      `letter-spacing="${type.metaTracking}em">${esc(topMeta.join(" · "))}</text>`,
  );
  const sideText = contrastText(ink.accent);
  const sideItems = [
    typeLabel === "left" ? kind.toUpperCase() : "",
    stateLabel === "left" ? `${glyph} ${n.node.state.toUpperCase()}` : "",
  ].filter(Boolean);
  if (sideItems.length) {
    parts.push(
      `<text class="skym-side-label" x="${(-n.h / 2).toFixed(1)}" y="${(n.sideRail / 2 + 3).toFixed(1)}" ` +
        `transform="rotate(-90)" fill="${sideText}" font-size="${type.metaSize}" font-weight="700" ` +
        `letter-spacing="${type.metaTracking}em" text-anchor="middle">${esc(sideItems.join(" · "))}</text>`,
    );
  }
  y += n.metaHeight;

  for (const line of n.titleLines) {
    y += type.titleLeading;
    parts.push(
      `<text class="skym-title" x="${left}" y="${(y - 4).toFixed(1)}" fill="${palette.ink}" ` +
        `font-size="${type.titleSize}" font-weight="${type.titleWeight}">${esc(line)}</text>`,
    );
  }

  if (n.bulletLines.length) {
    y += c.gap;
    for (const line of n.bulletLines) {
      y += type.bulletLeading;
      const baseline = (y - 4).toFixed(1);
      if (line.first) {
        parts.push(
          `<circle cx="${(left + 2.5).toFixed(1)}" cy="${(y - 8).toFixed(1)}" r="1.8" fill="${palette.inkMuted}"/>`,
        );
      }
      parts.push(
        `<text class="skym-bullet" x="${(left + 11).toFixed(1)}" y="${baseline}" fill="${palette.inkSecondary}" ` +
          `font-size="${type.bulletSize}">${esc(line.text)}</text>`,
      );
    }
  }

  if (n.hiddenBullets > 0) {
    y += type.bulletLeading;
    parts.push(
      `<text class="skym-more" x="${(left + 11).toFixed(1)}" y="${(y - 4).toFixed(1)}" fill="${palette.inkMuted}" ` +
        `font-size="${type.bulletSize - 0.5}" font-style="italic">+${n.hiddenBullets} more</text>`,
    );
  }

  if (n.figure) {
    const f = n.figure;
    const src = o.figureSrc(n.node.figures[0].file);
    parts.push(
      `<clipPath id="clip-${esc(cssId(n.id))}"><rect x="${f.x}" y="${f.y.toFixed(1)}" width="${f.w}" height="${f.h}" rx="6"/></clipPath>`,
    );
    // Figures are usually transparent-background plots authored for light, so
    // the plate stays light in both modes rather than swallowing the ink.
    parts.push(
      `<rect x="${f.x}" y="${f.y.toFixed(1)}" width="${f.w}" height="${f.h}" rx="6" fill="${palette.figurePlate}" stroke="${palette.hairline}" stroke-width="1"/>`,
    );
    parts.push(
      `<image class="skym-figure" data-file="${esc(n.node.figures[0].file)}" href="${esc(src)}" ` +
        `x="${f.x}" y="${f.y.toFixed(1)}" width="${f.w}" height="${f.h}" ` +
        `preserveAspectRatio="xMidYMid meet" clip-path="url(#clip-${esc(cssId(n.id))})"/>`,
    );
    if (n.node.figures.length > 1) {
      const badge = `+${n.node.figures.length - 1}`;
      const bw = textWidth(badge, 10, 600) + 12;
      parts.push(
        `<rect x="${(f.x + f.w - bw - 6).toFixed(1)}" y="${(f.y + 6).toFixed(1)}" width="${bw.toFixed(1)}" height="16" rx="8" fill="${palette.ink}" opacity="0.72"/>`,
      );
      parts.push(
        `<text x="${(f.x + f.w - bw / 2 - 6).toFixed(1)}" y="${(f.y + 17.5).toFixed(1)}" fill="${palette.card}" ` +
          `font-size="10" font-weight="600" text-anchor="middle">${esc(badge)}</text>`,
      );
    }
  } else if (n.node.figures.length) {
    const label = `${n.node.figures.length} figure${n.node.figures.length > 1 ? "s" : ""}`;
    const fileOffset = n.node.artifacts?.length ? c.gap + type.metaSize + 4 : 0;
    parts.push(
      `<text class="skym-figcount" x="${left}" y="${(n.h - c.padY - 1 - fileOffset).toFixed(1)}" fill="${palette.inkMuted}" ` +
        `font-size="${type.metaSize}" font-weight="${type.metaWeight}" letter-spacing="${type.metaTracking}em">▣ ${esc(label.toUpperCase())}</text>`,
    );
  }

  if (n.node.artifacts?.length) {
    const label = `${n.node.artifacts.length} file${n.node.artifacts.length > 1 ? "s" : ""}`;
    parts.push(
      `<text class="skym-filecount" x="${left}" y="${(n.h - c.padY - 1).toFixed(1)}" fill="${palette.inkMuted}" ` +
        `font-size="${type.metaSize}" font-weight="${type.metaWeight}" letter-spacing="${type.metaTracking}em">↧ ${esc(label.toUpperCase())}</text>`,
    );
  }

  parts.push("</g>");
  return parts.join("");
}

const cssId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function contrastText(hex: string): string {
  const value = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111827" : "#ffffff";
}

/** Left stripe following the card's rounded left corners. */
function stripePath(h: number, r: number, w: number): string {
  const bottom = h.toFixed(1);
  return (
    `M${r},0 L${Math.max(w, r)},0 L${Math.max(w, r)},${bottom} L${r},${bottom} ` +
    `Q0,${bottom} 0,${(h - r).toFixed(1)} L0,${r} Q0,0 ${r},0 Z`
  );
}

function edgeMarkup(layout: LayoutResult, o: RenderOptions): string {
  const { palette, theme } = o;
  const out: string[] = [];
  for (const e of layout.edges) {
    const dash = e.dashed ? ` stroke-dasharray="5 4"` : "";
    out.push(
      `<path class="skym-edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${e.path}" fill="none" ` +
        `stroke="${palette.edge}" stroke-width="${theme.layout.edgeWidth}" stroke-linecap="round"${dash} ` +
        `marker-end="url(#skym-arrow)"/>`,
    );
  }
  for (const e of layout.edges) {
    if (!e.label || !e.labelPos) continue;
    const w = textWidth(e.label, 11) + 12;
    out.push(
      `<rect x="${(e.labelPos.x - w / 2).toFixed(1)}" y="${(e.labelPos.y - 9).toFixed(1)}" width="${w.toFixed(1)}" height="18" rx="9" ` +
        `fill="${palette.surface}" stroke="${palette.hairline}" stroke-width="1"/>`,
      `<text x="${e.labelPos.x.toFixed(1)}" y="${(e.labelPos.y + 4).toFixed(1)}" fill="${palette.edgeLabel}" font-size="11" ` +
        `text-anchor="middle">${esc(e.label)}</text>`,
    );
  }
  return out.join("");
}

function clusterMarkup(layout: LayoutResult, o: RenderOptions): string {
  const { palette } = o;
  return layout.clusters
    .map(
      (c) =>
        `<g class="skym-cluster">` +
        `<rect x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" width="${c.w.toFixed(1)}" height="${c.h.toFixed(1)}" rx="14" ` +
        `fill="${palette.plane}" stroke="${palette.hairline}" stroke-width="1"/>` +
        `<text x="${(c.x + 16).toFixed(1)}" y="${(c.y + 20).toFixed(1)}" fill="${palette.inkMuted}" font-size="10.5" ` +
        `font-weight="600" letter-spacing="0.08em">${esc(c.name.toUpperCase())}</text>` +
        `</g>`,
    )
    .join("");
}

export function renderSvg(layout: LayoutResult, o: RenderOptions): string {
  const { palette, theme } = o;
  const w = Math.max(layout.width, 1);
  const h = Math.max(layout.height, 1);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="skym-svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" ` +
      `viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" font-family="${esc(theme.type.family)}">`,
    `<defs>`,
    // markerUnits=userSpaceOnUse keeps the head a fixed size instead of scaling
    // with stroke width, and the slight concave back stops it reading as a blob.
    `<marker id="skym-arrow" viewBox="0 0 12 12" refX="10.5" refY="6" ` +
      `markerWidth="${theme.layout.arrow * 1.5}" markerHeight="${theme.layout.arrow * 1.5}" ` +
      `markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
      `<path d="M1,1.4 L11,6 L1,10.6 L2.9,6 Z" fill="${palette.edge}"/></marker>`,
    `</defs>`,
    clusterMarkup(layout, o),
    edgeMarkup(layout, o),
    layout.nodes.map((n) => card(n, o)).join(""),
    `</svg>`,
  ].join("");
}
