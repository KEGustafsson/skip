import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import type { IPathUpdate } from '../../core/services/data.service';
import { ITheme } from '../../core/services/app-service';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective, widgetPathSignature } from '../../core/directives/widget-streams.directive';

/**
 * Sea Horizon — a marine attitude indicator.
 *
 * Deliberately NOT an aviation artificial horizon, which is what the older Pitch & Roll widget
 * (widget-horizon, the steelseries `Horizon` gauge) is. An aircraft instrument treats pitch as the
 * primary axis, bank as a commanded input, and rules its scale to 90°. A hull cares about heel over
 * roughly ±40° and trim over ±10°, and a hull pitching 20° is in trouble rather than manoeuvring.
 * So here the ground is sea rather than earth, the pitch ladder is ruled every 2.5° and labelled
 * every 5°, the heel scale stops at 45° and carries nominal / caution / alarm bands with a red
 * limit index at a configurable angle, and the fixed reference symbol is a deck bar with a mast
 * stub rather than an aircraft.
 *
 * It wears the same Classic Steel case as Skip's other steel gauges, but draws it as SVG: bezel,
 * bevel, face vignette, glass crescent, engraved scale and LCD insets are gradients and paths. That
 * is why this widget has none of widget-horizon's resize plumbing — no ResizeObserver, no
 * size-stabilisation timer, no gauge rebuild on resize. Those exist only because steelseries draws
 * into a fixed-pixel canvas; a fixed viewBox scales for free and stays crisp on a retina MFD.
 */

// ---------------------------------------------------------------------------
// Fixed geometry. The viewBox never changes, so every static coordinate below is
// computed once at module load rather than per instance or per frame.
// ---------------------------------------------------------------------------
const CX = 150;
const CY = 150;

// The case is the steelseries Classic Steel case, reproduced exactly: every radius below is the
// fraction drawFrame.js uses, resolved against this 300x300 viewBox, and the finishes further down
// carry that library's own gradient stops. Skip's Classic Steel widget renders the real library, so
// the two sit side by side on a dashboard and have to agree.
/** Outer edge of the case. */
const FRAME_R = 150;
/** The bright ring between finish and face (0.841121). */
const FRAME_INNER_R = 126.168;
/** The dial face (0.83). */
const FACE_R = 124.5;
/** Radius the face's inner shadow and side vignette are drawn to (0.831775). */
const FACE_SHADOW_R = 124.766;
/**
 * Bounds of the ring a conical finish fills (0.42056 and 0.495327 of the width). The outer bound is
 * also the radius of the circle every other finish paints its gradient on.
 */
const CONIC_INNER_R = 126.168;
const CONIC_OUTER_R = 148.598;

/**
 * The dial — window, scale, reference symbol and LCDs — is laid out against this radius and then
 * scaled onto the real face. Keeping a design radius separate from the face radius means the case
 * can follow steelseries' proportions without every tick and label having to be re-tuned.
 */
const DIAL_R = 112;
/** The window the horizon is drawn through. */
const WIN_R = 78;
/** Pixels per degree of pitch. Aviation ladders run ~5px/deg over ±30°; a hull needs ±15°. */
const PITCH_PX_PER_DEG = 5.8;
/** Largest heel the scale is ruled to. */
const HEEL_SCALE_MAX = 45;
const BAND_R_INNER = DIAL_R - 13;
const BAND_R_OUTER = DIAL_R - 8;
const TICK_R = DIAL_R - 3;
const NUMERAL_R = DIAL_R - 24;
const LIMIT_R_OUTER = DIAL_R - 2;
const LIMIT_R_INNER = DIAL_R - 20;

const COLOR_NOMINAL = '#2FA84F';
const COLOR_CAUTION = '#E8912B';
const COLOR_ALARM = '#CE2A20';

const DEFAULT_CAUTION_ANGLE = 20;
const DEFAULT_ALARM_ANGLE = 30;
const DEFAULT_FRAME_DESIGN = 'anthracite';

export interface IGradientStop { o: string; c: string; }
interface ITick { x1: number; y1: number; x2: number; y2: number; major: boolean; }
interface INumeral { x: number; y: number; text: string; transform: string; }
interface ILadderRung { x1: number; x2: number; y: number; major: boolean; }
interface ILadderLabel { x: number; y: number; text: string; anchor: 'start' | 'end'; }
interface IHeelBand { d: string; fill: string; }
interface ILimitIndex { x1: number; y1: number; x2: number; y2: number; }

/** Degrees measured from 12 o'clock, clockwise positive — starboard heel is positive. */
function polar(r: number, deg: number): [number, number] {
  const a = (deg - 90) * Math.PI / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

/**
 * A filled arc segment between two radii, used for the nominal / caution / alarm bands. Angles are
 * in the same 12-o'clock-clockwise frame as {@link polar}, so a span reads port-to-starboard.
 */
function bandPath(rIn: number, rOut: number, a0: number, a1: number): string {
  const [ox0, oy0] = polar(rOut, a0);
  const [ox1, oy1] = polar(rOut, a1);
  const [ix1, iy1] = polar(rIn, a1);
  const [ix0, iy0] = polar(rIn, a0);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${ox0.toFixed(2)},${oy0.toFixed(2)}` +
    ` A${rOut},${rOut} 0 ${large} 1 ${ox1.toFixed(2)},${oy1.toFixed(2)}` +
    ` L${ix1.toFixed(2)},${iy1.toFixed(2)}` +
    ` A${rIn},${rIn} 0 ${large} 0 ${ix0.toFixed(2)},${iy0.toFixed(2)} Z`;
}

/** Confine a value to an inclusive range. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Heel scale: a tick every 5°, major every 10°. */
const HEEL_TICKS: ITick[] = (() => {
  const ticks: ITick[] = [];
  for (let a = -HEEL_SCALE_MAX; a <= HEEL_SCALE_MAX; a += 5) {
    const major = a % 10 === 0;
    const [x1, y1] = polar(TICK_R, a);
    const [x2, y2] = polar(TICK_R - (major ? 13 : 7), a);
    ticks.push({ x1, y1, x2, y2, major });
  }
  return ticks;
})();

/**
 * Only 20 and 40 carry numerals. Numbering every major mark crowds the top of the scale to the
 * point of illegibility at tile size, and the ticks already locate 10 and 30.
 */
const HEEL_NUMERALS: INumeral[] = [-40, -20, 20, 40].map(a => {
  const [x, y] = polar(NUMERAL_R, a);
  return { x, y: y + 3.96, text: String(Math.abs(a)), transform: `rotate(${a} ${x.toFixed(2)} ${y.toFixed(2)})` };
});

/** Pitch ladder: a rung every 2.5°, labelled every 5°. */
const LADDER_RUNGS: ILadderRung[] = [];
const LADDER_LABELS: ILadderLabel[] = [];
for (const p of [-15, -12.5, -10, -7.5, -5, -2.5, 2.5, 5, 7.5, 10, 12.5, 15]) {
  const major = Math.abs(p) % 5 === 0;
  const half = major ? 26 : 11;
  const y = CY - p * PITCH_PX_PER_DEG;
  LADDER_RUNGS.push({ x1: CX - half, x2: CX + half, y, major });
  if (major) {
    LADDER_LABELS.push({ x: CX - half - 6, y: y + 3.2, text: String(Math.abs(p)), anchor: 'end' });
    LADDER_LABELS.push({ x: CX + half + 6, y: y + 3.2, text: String(Math.abs(p)), anchor: 'start' });
  }
}

/** The rim index the heel scale is read against. Points inward from the bezel. */
const POINTER_PATH = `M${CX},${CY - (DIAL_R - 1) + 15} l-8.5,-15 l17,0 Z`;

/**
 * The glass. This is drawForeground.js's type-1 highlight, its bezier control points resolved
 * against the viewBox — the dome across the upper half that makes the steel gauges read as glazed.
 */
const GLASS_PATH =
  'M25.234,152.804' +
  ' C61.682,134.579 100.934,124.766 150,124.766' +
  ' C201.869,124.766 236.916,133.178 274.766,152.804' +
  ' C274.766,82.710 221.495,25.234 150,25.234' +
  ' C78.505,25.234 25.234,82.710 25.234,152.804 Z';
const GLASS_GRAD = { y1: 26.636, y2: 147.196 };

/** LCD insets: the rect, plus the baseline of the text centred in it. */
const LCD_HEEL = { x: CX - 56, y: CY + 46, w: 112, h: 30, size: 20, textY: CY + 46 + 15 + 20 * 0.36 };
const LCD_TRIM = { x: CX - 40, y: CY + 82, w: 80, h: 17, size: 10.5, textY: CY + 82 + 8.5 + 10.5 * 0.36 };

/** A finish is a stack of filled circles, or — for the brushed ones — a ring of conical wedges. */
interface IFrameGradient {
  kind: 'linear' | 'radial';
  x1?: number; y1?: number; x2?: number; y2?: number;
  cx?: number; cy?: number; r?: number;
  stops: IGradientStop[];
}
interface IFrameLayer { r: number; grad?: number; fill?: string; }
interface IFrameDesign {
  gradients: IFrameGradient[];
  layers: IFrameLayer[];
  /** Brushed finishes are a conical sweep, which SVG has no primitive for — see conicalWedges(). */
  conical?: { fractions: number[]; colors: string[] };
}

/** One wedge of an approximated conical sweep: an annulus segment and the colours of its two edges. */
interface IFrameWedge { d: string; x1: number; y1: number; x2: number; y2: number; c0: string; c1: string; }

/**
 * Bezel finishes, taken from steelseries' drawFrame.js and resolved against this viewBox, keyed by
 * the same `gauge.faceColor` values Skip's steel gauges already store. Generated from that source
 * rather than transcribed, so a finish reads identically here and on a Classic Steel gauge next to it.
 */
const FRAME_DESIGNS: Record<string, IFrameDesign> = {
  metal: {
    gradients: [
      { kind: 'linear', x1: 0, y1: 1.402, x2: 0, y2: 297.196,
        stops: [{ o: '0.0', c: '#FEFEFE' }, { o: '0.07', c: '#D2D2D2' }, { o: '0.12', c: '#B3B3B3' }, { o: '1.0', c: '#D5D5D5' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }]
  },
  brass: {
    gradients: [
      { kind: 'linear', x1: 0, y1: 1.402, x2: 0, y2: 297.196,
        stops: [{ o: '0.0', c: '#F9F39B' }, { o: '0.05', c: '#F6E265' }, { o: '0.1', c: '#F0E184' }, { o: '0.5', c: '#5A3916' }, { o: '0.9', c: '#F9ED8B' }, { o: '0.95', c: '#F3E26C' }, { o: '1.0', c: '#CAB671' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }]
  },
  steel: {
    gradients: [
      { kind: 'linear', x1: 0, y1: 1.402, x2: 0, y2: 297.196,
        stops: [{ o: '0.0', c: '#E7EDED' }, { o: '0.05', c: '#BDC7C6' }, { o: '0.1', c: '#C0C9C8' }, { o: '0.5', c: '#171F21' }, { o: '0.9', c: '#C4CDCC' }, { o: '0.95', c: '#C2CCCB' }, { o: '1.0', c: '#BDC9C7' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }]
  },
  gold: {
    gradients: [
      { kind: 'linear', x1: 0, y1: 1.402, x2: 0, y2: 297.196,
        stops: [{ o: '0.0', c: '#FFFFCF' }, { o: '0.15', c: '#FFED60' }, { o: '0.22', c: '#FEC739' }, { o: '0.3', c: '#FFF9CB' }, { o: '0.38', c: '#FFC740' }, { o: '0.44', c: '#FCC23C' }, { o: '0.51', c: '#FFCC3B' }, { o: '0.6', c: '#D5861D' }, { o: '0.68', c: '#FFC938' }, { o: '0.75', c: '#D4871D' }, { o: '1.0', c: '#F7EE65' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }]
  },
  anthracite: {
    gradients: [
      { kind: 'linear', x1: 0, y1: 1.402, x2: 0, y2: 298.598,
        stops: [{ o: '0.0', c: '#767587' }, { o: '0.06', c: '#4A4A52' }, { o: '0.12', c: '#323236' }, { o: '1.0', c: '#4F4F57' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }]
  },
  tiltedGray: {
    gradients: [
      { kind: 'linear', x1: 70.093, y1: 25.234, x2: 243.774, y2: 273.276,
        stops: [{ o: '0.0', c: '#FFFFFF' }, { o: '0.07', c: '#D2D2D2' }, { o: '0.16', c: '#B3B3B3' }, { o: '0.33', c: '#FFFFFF' }, { o: '0.55', c: '#C5C5C5' }, { o: '0.79', c: '#FFFFFF' }, { o: '1.0', c: '#666666' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }]
  },
  tiltedBlack: {
    gradients: [
      { kind: 'linear', x1: 68.691, y1: 23.832, x2: 240.764, y2: 269.577,
        stops: [{ o: '0.0', c: '#666666' }, { o: '0.21', c: '#000000' }, { o: '0.47', c: '#666666' }, { o: '0.99', c: '#000000' }, { o: '1.0', c: '#000000' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }]
  },
  glossyMetal: {
    gradients: [
      { kind: 'radial', cx: 150.0, cy: 150.0, r: 150.0,
        stops: [{ o: '0.0', c: '#CFCFCF' }, { o: '0.96', c: '#CDCCCD' }, { o: '1.0', c: '#F4F4F4' }] },
      { kind: 'linear', x1: 0, y1: 8.411, x2: 0, y2: 291.589,
        stops: [{ o: '0.0', c: '#F9F9F9' }, { o: '0.23', c: '#C8C3BF' }, { o: '0.36', c: '#FFFFFF' }, { o: '0.59', c: '#1D1D1D' }, { o: '0.76', c: '#C8C2C0' }, { o: '1.0', c: '#D1D1D1' }] },
    ],
    layers: [{ r: 148.598, grad: 0 }, { r: 146.094, grad: 1 }, { r: 130.374, fill: '#F6F6F6' }, { r: 127.5, fill: '#333333' }]
  },
  blackMetal: {
    gradients: [], layers: [],
    conical: {
      fractions: [0.0, 0.125, 0.347222, 0.5, 0.680555, 0.875, 1.0],
      colors: ['#FEFEFE', '#000000', '#999999', '#000000', '#999999', '#000000', '#FEFEFE']
    }
  },
  shinyMetal: {
    gradients: [], layers: [],
    conical: {
      fractions: [0.0, 0.125, 0.25, 0.347222, 0.5, 0.652777, 0.75, 0.875, 1.0],
      colors: ['#FEFEFE', '#D2D2D2', '#B3B3B3', '#EEEEEE', '#A0A0A0', '#EEEEEE', '#B3B3B3', '#D2D2D2', '#FEFEFE']
    }
  },
  chrome: {
    gradients: [], layers: [],
    conical: {
      fractions: [0.0, 0.09, 0.12, 0.16, 0.25, 0.29, 0.33, 0.38, 0.48, 0.52, 0.63, 0.68, 0.8, 0.83, 0.87, 0.97, 1.0],
      colors: ['#FFFFFF', '#FFFFFF', '#88888A', '#A4B9BE', '#9EB3B6', '#707070', '#DDE3E3', '#9BB0B3', '#9CB0B1', '#FEFFFF', '#FFFFFF', '#9CB4B4', '#C6D1D3', '#F6F8F7', '#CCD8D8', '#A4BCBE', '#FFFFFF']
    }
  },
};

/** Linear RGB interpolation between two #rrggbb colours, which is what steelseries' sweep uses. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => {
    const va = (pa >> sh) & 255, vb = (pb >> sh) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/**
 * Colour of a conical sweep at a screen angle, measured clockwise from 12 o'clock.
 *
 * steelseries builds these per-pixel from `atan2` and then flips the buffer vertically, which works
 * out to fraction = 1 - deg/360. That mapping was confirmed against a rendered gauge rather than
 * derived on paper: sampling the real blackMetal bezel gives white at 0°, black at 45°/180°/315°
 * and grey at 115°/235°, which is exactly what this returns.
 */
function conicalColorAt(fractions: number[], colors: string[], deg: number): string {
  const f = clamp(1 - (((deg % 360) + 360) % 360) / 360, 0, 1);
  for (let i = 0; i < fractions.length - 1; i++) {
    if (f >= fractions[i] && f <= fractions[i + 1]) {
      const span = fractions[i + 1] - fractions[i];
      return mixHex(colors[i], colors[i + 1], span === 0 ? 0 : (f - fractions[i]) / span);
    }
  }
  return colors[colors.length - 1];
}

/**
 * SVG has no conical gradient, so a brushed finish is drawn as a ring of wedges, each carrying a
 * linear gradient between the colours of its own two edges. The sweep is linear in angle within a
 * segment, so matching both edges makes each wedge accurate to the width of the arc it spans; 24 of
 * them is indistinguishable from the real thing and costs a fraction of the elements a per-degree
 * fan would. Only a brushed finish emits these at all.
 */
const CONIC_WEDGES = 24;
function conicalWedges(fractions: number[], colors: string[]): IFrameWedge[] {
  const rMid = (CONIC_INNER_R + CONIC_OUTER_R) / 2;
  const wedges: IFrameWedge[] = [];
  for (let i = 0; i < CONIC_WEDGES; i++) {
    const d0 = (i * 360) / CONIC_WEDGES;
    const d1 = ((i + 1) * 360) / CONIC_WEDGES;
    const [x1, y1] = polar(rMid, d0);
    const [x2, y2] = polar(rMid, d1);
    wedges.push({
      d: bandPath(CONIC_INNER_R, CONIC_OUTER_R, d0, d1),
      x1, y1, x2, y2,
      c0: conicalColorAt(fractions, colors, d0),
      c1: conicalColorAt(fractions, colors, d1)
    });
  }
  return wedges;
}

/**
 * The face's inner shadow and its side vignette, both from drawBackground.js. Together they are what
 * stops the face reading as flat paint under the glass.
 */
const FACE_SHADOW_STOPS: IGradientStop[] = [
  { o: '0', c: 'rgba(0,0,0,0)' }, { o: '0.7', c: 'rgba(0,0,0,0)' }, { o: '0.71', c: 'rgba(0,0,0,0)' },
  { o: '0.86', c: 'rgba(0,0,0,0.03)' }, { o: '0.92', c: 'rgba(0,0,0,0.07)' },
  { o: '0.97', c: 'rgba(0,0,0,0.15)' }, { o: '1', c: 'rgba(0,0,0,0.3)' }
];
const FACE_VIGNETTE_STOPS: IGradientStop[] = [
  { o: '0', c: 'rgba(0,0,0,0.25)' }, { o: '0.5', c: 'rgba(0,0,0,0)' }, { o: '1', c: 'rgba(0,0,0,0.25)' }
];

/** The LCD inset, from createLcdBackgroundImage.js with the STANDARD colour set. */
const LCD_BEZEL_STOPS: IGradientStop[] = [
  { o: '0', c: '#4C4C4C' }, { o: '0.08', c: '#666666' }, { o: '0.92', c: '#666666' }, { o: '1', c: '#E6E6E6' }
];
const LCD_FACE_STOPS: IGradientStop[] = [
  { o: '0', c: 'rgb(131,133,119)' }, { o: '0.03', c: 'rgb(176,183,167)' }, { o: '0.49', c: 'rgb(165,174,153)' },
  { o: '0.5', c: 'rgb(166,175,156)' }, { o: '1', c: 'rgb(175,184,165)' }
];

@Component({
  selector: 'widget-sea-horizon',
  templateUrl: './widget-sea-horizon.component.html',
  styleUrls: ['./widget-sea-horizon.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetSeaHorizonComponent {
  // Host2 inputs
  public id = input.required<string>();
  public type = input.required<string>();
  public theme = input.required<ITheme | null>();

  protected readonly runtime = inject(WidgetRuntimeDirective);
  private readonly streams = inject(WidgetStreamsDirective);
  private readonly destroyRef = inject(DestroyRef);

  public static readonly DEFAULT_CONFIG: IWidgetSvcConfig = {
    supportAutomaticHistoricalSeries: false,
    displayName: 'Sea Horizon',
    filterSelfPaths: true,
    paths: {
      // pathType stays 'number' though the path is the whole navigation.attitude object: the
      // streams pipeline extracts the pitch/roll sub-field (observe below) BEFORE the number-type
      // conversion runs, so it converts the scalar rad->deg. Switching to 'object' would skip that
      // conversion and render radians. Both paths are fixed (isPathConfigurable:false) — no Paths tab.
      gaugePitchPath: {
        description: 'Attitude Pitch Data',
        path: 'self.navigation.attitude',
        source: 'default',
        pathType: 'number',
        pathRequired: false,
        isPathConfigurable: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      },
      gaugeRollPath: {
        description: 'Attitude Roll Data',
        path: 'self.navigation.attitude',
        source: 'default',
        pathType: 'number',
        pathRequired: false,
        isPathConfigurable: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      }
    },
    gauge: {
      type: 'seaHorizon',
      noFrameVisible: true,
      faceColor: 'anthracite',
      invertPitch: false,
      invertRoll: false,
      heelCautionAngle: 20,
      heelAlarmAngle: 30,
      damping: 0
    },
    numDecimal: 1,
    updateInterval: 1000,
    enableTimeout: true,
    dataTimeout: 5
  };

  // ---- live readings -------------------------------------------------------
  // Raw (un-inverted) degrees are what the signals hold, so flipping an axis in the config takes
  // effect at once rather than at the next sample.
  private readonly rawPitch = signal<number | null>(null);
  private readonly rawRoll = signal<number | null>(null);
  private lastPitchAt: number | null = null;
  private lastRollAt: number | null = null;
  private pitchSignature: string | null = null;
  private rollSignature: string | null = null;

  /**
   * Whether the world and pointer groups animate between readings. Off until the first reading has
   * painted, so the step from a level dial to the first real attitude is instant rather than a slow
   * sweep up from zero; off again whenever the reading is lost or re-pointed, so recovery snaps too.
   */
  protected readonly ready = signal(false);
  private transitionFrame: number | null = null;

  protected readonly pitchDeg = computed(() => {
    const v = this.rawPitch();
    if (v == null) return null;
    return this.runtime.options()?.gauge?.invertPitch ? -v : v;
  });
  protected readonly rollDeg = computed(() => {
    const v = this.rawRoll();
    if (v == null) return null;
    return this.runtime.options()?.gauge?.invertRoll ? -v : v;
  });

  /** Neither axis has produced a reading, or both have timed out. */
  protected readonly noData = computed(() => this.pitchDeg() === null && this.rollDeg() === null);

  // ---- static geometry, exposed to the template ----------------------------
  protected readonly heelTicks = HEEL_TICKS;
  protected readonly heelNumerals = HEEL_NUMERALS;
  protected readonly ladderRungs = LADDER_RUNGS;
  protected readonly ladderLabels = LADDER_LABELS;
  protected readonly pointerPath = POINTER_PATH;
  protected readonly glassPath = GLASS_PATH;
  protected readonly glassGrad = GLASS_GRAD;
  protected readonly lcdHeel = LCD_HEEL;
  protected readonly lcdTrim = LCD_TRIM;
  protected readonly lcdBezelStops = LCD_BEZEL_STOPS;
  protected readonly lcdFaceStops = LCD_FACE_STOPS;
  protected readonly faceShadowStops = FACE_SHADOW_STOPS;
  protected readonly faceVignetteStops = FACE_VIGNETTE_STOPS;
  protected readonly frameR = FRAME_R;
  protected readonly frameInnerR = FRAME_INNER_R;
  protected readonly faceR = FACE_R;
  protected readonly faceShadowR = FACE_SHADOW_R;
  protected readonly winR = WIN_R;
  protected readonly cx = CX;
  protected readonly cy = CY;

  // ---- configuration-derived geometry --------------------------------------
  /** "Show Frame" binds straight to noFrameVisible, so true means draw the bezel. */
  protected readonly frameVisible = computed(() => this.runtime.options()?.gauge?.noFrameVisible ?? false);

  /** With the bezel hidden the dial grows into the space the bezel would have occupied. */
  protected readonly dialTransform = computed(() => {
    // The dial is drawn against DIAL_R and scaled onto whatever it has to fill: the steelseries face
    // when the case is on, the whole tile when it is off.
    const scale = (this.frameVisible() ? FACE_R : FRAME_R) / DIAL_R;
    return `translate(${CX} ${CY}) scale(${scale.toFixed(4)}) translate(${-CX} ${-CY})`;
  });

  /**
   * Face shading and glass are authored at the steelseries face radius, so with the case on they
   * already sit on the dial's edge and need no transform. With it off the dial grows to fill the
   * tile, and they have to grow with it — otherwise the vignette and the glass dome stop short of
   * the edge and the dial reads as a small gauge floating in a dark ring.
   */
  protected readonly overlayTransform = computed(() => {
    if (this.frameVisible()) return null;
    const scale = FRAME_R / FACE_R;
    return `translate(${CX} ${CY}) scale(${scale.toFixed(4)}) translate(${-CX} ${-CY})`;
  });

  protected readonly cautionAngle = computed(() => {
    const raw = this.runtime.options()?.gauge?.heelCautionAngle;
    return clamp(typeof raw === 'number' && isFinite(raw) ? raw : DEFAULT_CAUTION_ANGLE, 1, HEEL_SCALE_MAX - 1);
  });

  protected readonly alarmAngle = computed(() => {
    const raw = this.runtime.options()?.gauge?.heelAlarmAngle;
    const alarm = clamp(typeof raw === 'number' && isFinite(raw) ? raw : DEFAULT_ALARM_ANGLE, 2, HEEL_SCALE_MAX);
    // An alarm angle at or below the caution angle would render a zero-width caution band and an
    // alarm band starting before the caution it is meant to escalate from.
    return Math.max(alarm, this.cautionAngle() + 1);
  });

  /** Nominal / caution / alarm arcs, mirrored port and starboard. */
  protected readonly heelBands = computed<IHeelBand[]>(() => {
    const caution = this.cautionAngle();
    const alarm = this.alarmAngle();
    const spans: [number, number, string][] = [
      [0, caution, COLOR_NOMINAL],
      [caution, alarm, COLOR_CAUTION],
      [alarm, HEEL_SCALE_MAX + 1, COLOR_ALARM]
    ];
    const bands: IHeelBand[] = [];
    for (const [from, to, fill] of spans) {
      if (to <= from) continue;
      bands.push({ d: bandPath(BAND_R_INNER, BAND_R_OUTER, from, to), fill });
      bands.push({ d: bandPath(BAND_R_INNER, BAND_R_OUTER, -to, -from), fill });
    }
    return bands;
  });

  /** The red index marking the configured alarm angle, port and starboard. */
  protected readonly limitIndexes = computed<ILimitIndex[]>(() =>
    [this.alarmAngle(), -this.alarmAngle()].map(a => {
      const [x1, y1] = polar(LIMIT_R_OUTER, a);
      const [x2, y2] = polar(LIMIT_R_INNER, a);
      return { x1, y1, x2, y2 };
    })
  );

  /** The finish the stored `gauge.faceColor` selects, falling back to the default it ships with. */
  private readonly frameDesign = computed<IFrameDesign>(() => {
    const key = this.runtime.options()?.gauge?.faceColor ?? DEFAULT_FRAME_DESIGN;
    return FRAME_DESIGNS[key] ?? FRAME_DESIGNS[DEFAULT_FRAME_DESIGN];
  });

  protected readonly frameGradients = computed(() =>
    this.frameDesign().gradients.map((g, i) => ({ ...g, id: `skh-fg${i}-${this.id()}` }))
  );

  /** Filled circles making up the finish, innermost last, with gradient references resolved. */
  protected readonly frameLayers = computed(() => {
    const grads = this.frameGradients();
    return this.frameDesign().layers.map(l => ({
      r: l.r,
      fill: l.grad === undefined ? (l.fill ?? 'none') : `url(#${grads[l.grad].id})`
    }));
  });

  /** Empty for every finish but the three brushed ones. */
  protected readonly frameWedges = computed(() => {
    const conical = this.frameDesign().conical;
    if (!conical) return [];
    const suffix = this.id();
    return conicalWedges(conical.fractions, conical.colors)
      .map((w, i) => ({ ...w, id: `skh-wg${i}-${suffix}` }));
  });

  // ---- animated transforms -------------------------------------------------
  protected readonly worldTransform = computed(() => {
    const roll = this.rollDeg() ?? 0;
    const pitch = clamp(this.pitchDeg() ?? 0, -40, 40);
    return `rotate(${(-roll).toFixed(2)} ${CX} ${CY}) translate(0 ${(pitch * PITCH_PX_PER_DEG).toFixed(2)})`;
  });

  protected readonly pointerTransform = computed(() => {
    // The scale stops at 45°, so past that the index parks just off the last mark rather than
    // running round the dial, while the horizon itself keeps rotating truthfully.
    const roll = clamp(this.rollDeg() ?? 0, -HEEL_SCALE_MAX - 3, HEEL_SCALE_MAX + 3);
    return `rotate(${roll.toFixed(2)} ${CX} ${CY})`;
  });

  protected readonly motionTransition = computed(() => {
    const ms = this.runtime.options()?.updateInterval ?? 1000;
    return `transform ${Math.max(100, ms * 0.95)}ms linear`;
  });

  // ---- readouts ------------------------------------------------------------
  private readonly decimals = computed(() => this.runtime.options()?.numDecimal ?? 1);

  protected readonly heelText = computed(() => {
    const roll = this.rollDeg();
    if (roll == null) return '--';
    const side = roll > 0.35 ? 'STBD' : roll < -0.35 ? 'PORT' : 'LEVEL';
    return `${Math.abs(roll).toFixed(this.decimals())}° ${side}`;
  });

  protected readonly trimText = computed(() => {
    const pitch = this.pitchDeg();
    if (pitch == null) return 'TRIM --';
    return `TRIM ${pitch >= 0 ? '+' : '−'}${Math.abs(pitch).toFixed(this.decimals())}°`;
  });

  protected readonly ariaLabel = computed(() =>
    this.noData() ? 'Sea horizon: no attitude data' : `Sea horizon: heel ${this.heelText()}, ${this.trimText()}`
  );

  // ---- gradient / clip ids, namespaced per widget instance ------------------
  // Several of these gauges can share a dashboard, and a duplicate gradient id would have every
  // instance paint with whichever definition the document happened to resolve first.
  protected readonly ids = computed(() => {
    const suffix = this.id();
    return {
      sky: `skh-sky-${suffix}`,
      sea: `skh-sea-${suffix}`,
      glass: `skh-glass-${suffix}`,
      shadow: `skh-shadow-${suffix}`,
      vignette: `skh-vignette-${suffix}`,
      lcdBezel: `skh-lcdb-${suffix}`,
      lcdFace: `skh-lcdf-${suffix}`,
      window: `skh-window-${suffix}`
    };
  });

  protected readonly url = computed(() => {
    const r = this.ids();
    return {
      sky: `url(#${r.sky})`, sea: `url(#${r.sea})`, glass: `url(#${r.glass})`,
      shadow: `url(#${r.shadow})`, vignette: `url(#${r.vignette})`,
      lcdBezel: `url(#${r.lcdBezel})`, lcdFace: `url(#${r.lcdFace})`, window: `url(#${r.window})`
    };
  });

  constructor() {
    effect(() => {
      const cfg = this.runtime.options();
      if (!cfg) return;
      const pathCfg = cfg.paths?.['gaugePitchPath'];
      const signature = widgetPathSignature(pathCfg);
      untracked(() => {
        // A re-point rebuilds the subscription, but suppressBootstrapNull filters the replayed
        // leading null — against a path that reports nothing the callback never runs, and the
        // previous path's reading would stay on the dial as a live reading of the new one.
        if (signature !== this.pitchSignature) {
          this.pitchSignature = signature;
          this.rawPitch.set(null);
          this.lastPitchAt = null;
          this.disarmTransitions();
        }
        if (!pathCfg?.path) return;
        // The callback is a stable class field: the streams directive rebuilds the whole pipeline
        // when it is handed a different function, so a fresh closure here would tear down and
        // re-subscribe both paths on every unrelated config edit (finish, damping, an invert flag).
        this.streams.observe('gaugePitchPath', this.onPitch, 'pitch');
      });
    });

    effect(() => {
      const cfg = this.runtime.options();
      if (!cfg) return;
      const pathCfg = cfg.paths?.['gaugeRollPath'];
      const signature = widgetPathSignature(pathCfg);
      untracked(() => {
        if (signature !== this.rollSignature) {
          this.rollSignature = signature;
          this.rawRoll.set(null);
          this.lastRollAt = null;
          this.disarmTransitions();
        }
        if (!pathCfg?.path) return;
        this.streams.observe('gaugeRollPath', this.onRoll, 'roll');
      });
    });

    this.destroyRef.onDestroy(() => this.disarmTransitions());
  }

  /** Stream callback for the pitch sub-field: damp the sample, then settle the transition gate. */
  private readonly onPitch = (pkt: IPathUpdate): void => {
    this.rawPitch.set(this.damp(this.rawPitch(), pkt?.data?.value as number | null | undefined, 'pitch'));
    this.settleTransitions();
  };

  /** Stream callback for the roll sub-field: damp the sample, then settle the transition gate. */
  private readonly onRoll = (pkt: IPathUpdate): void => {
    this.rawRoll.set(this.damp(this.rawRoll(), pkt?.data?.value as number | null | undefined, 'roll'));
    this.settleTransitions();
  };

  /**
   * Arm transitions one frame after a reading lands, so that reading is drawn without one and only
   * later readings animate; drop them the moment the dial has nothing to show.
   */
  private settleTransitions(): void {
    if (this.noData()) {
      this.disarmTransitions();
      return;
    }
    if (this.ready() || this.transitionFrame !== null) return;
    this.transitionFrame = requestAnimationFrame(() => {
      this.transitionFrame = null;
      this.ready.set(true);
    });
  }

  private disarmTransitions(): void {
    if (this.transitionFrame !== null) {
      cancelAnimationFrame(this.transitionFrame);
      this.transitionFrame = null;
    }
    this.ready.set(false);
  }

  /**
   * Exponential smoothing with a configurable time constant. Attitude off a real IMU in a seaway is
   * noisy at a level an aviation instrument never has to handle, and an undamped dial in 20 knots
   * reads as broken. A time constant of 0 passes the sample straight through.
   */
  private damp(previous: number | null, next: number | null | undefined, axis: 'pitch' | 'roll'): number | null {
    if (next == null || !isFinite(next)) return null;
    const tau = this.runtime.options()?.gauge?.damping ?? 0;
    const now = Date.now();
    const last = axis === 'pitch' ? this.lastPitchAt : this.lastRollAt;
    if (axis === 'pitch') this.lastPitchAt = now; else this.lastRollAt = now;

    if (!(tau > 0) || previous == null || last == null) return next;
    const dt = (now - last) / 1000;
    if (dt <= 0) return previous;
    const alpha = 1 - Math.exp(-dt / tau);
    return previous + alpha * (next - previous);
  }
}
