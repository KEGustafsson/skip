import { AfterViewInit, ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
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
/** Outer edge of the bezel. */
const FRAME_R = 148;
/** Inner bevel ring. */
const BEVEL_R = 128;
/** Dark separator between bevel and face. */
const GAP_R = 118;
/** The dial face itself. */
const FACE_R = 112;
/** The window the horizon is drawn through. */
const WIN_R = 78;
/** Pixels per degree of pitch. Aviation ladders run ~5px/deg over ±30°; a hull needs ±15°. */
const PITCH_PX_PER_DEG = 5.8;
/** Largest heel the scale is ruled to. */
const HEEL_SCALE_MAX = 45;
/** Applied to the whole dial when the bezel is hidden, so it still fills the tile. */
const NO_FRAME_SCALE = 1.3;

const BAND_R_INNER = FACE_R - 13;
const BAND_R_OUTER = FACE_R - 8;
const TICK_R = FACE_R - 3;
const NUMERAL_R = FACE_R - 24;
const LIMIT_R_OUTER = FACE_R - 2;
const LIMIT_R_INNER = FACE_R - 20;

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
const POINTER_PATH = `M${CX},${CY - (FACE_R - 1) + 15} l-8.5,-15 l17,0 Z`;

const GLASS_ELLIPSE = { cx: CX, cy: CY - FACE_R * 0.34, rx: FACE_R * 0.92, ry: FACE_R * 0.56 };

/** LCD insets: the rect, plus the baseline of the text centred in it. */
const LCD_HEEL = { x: CX - 56, y: CY + 46, w: 112, h: 30, size: 20, textY: CY + 46 + 15 + 20 * 0.36 };
const LCD_TRIM = { x: CX - 40, y: CY + 82, w: 80, h: 17, size: 10.5, textY: CY + 82 + 8.5 + 10.5 * 0.36 };

/**
 * Bezel finishes, keyed by the same `gauge.faceColor` values Skip's steel gauges already store, so
 * the finish reads the same across the steel family. Each is a vertical gradient: bright at the
 * top, dark through the middle where the bezel turns away, lifting again at the bottom.
 */
const FRAME_DESIGNS: Record<string, IGradientStop[]> = {
  anthracite: [
    { o: '0', c: '#F4F5F5' }, { o: '0.06', c: '#C3C6C8' }, { o: '0.17', c: '#4A4E51' }, { o: '0.34', c: '#101314' },
    { o: '0.52', c: '#191D1F' }, { o: '0.72', c: '#3E4346' }, { o: '0.88', c: '#8E9396' }, { o: '1', c: '#D9DCDD' }
  ],
  blackMetal: [
    { o: '0', c: '#E4E4E4' }, { o: '0.06', c: '#8A8A8A' }, { o: '0.18', c: '#1F1F1F' }, { o: '0.36', c: '#000000' },
    { o: '0.54', c: '#0B0B0B' }, { o: '0.74', c: '#242424' }, { o: '0.89', c: '#5E5E5E' }, { o: '1', c: '#B2B2B2' }
  ],
  metal: [
    { o: '0', c: '#FFFFFF' }, { o: '0.07', c: '#D6D6D6' }, { o: '0.2', c: '#8E8E8E' }, { o: '0.38', c: '#575757' },
    { o: '0.56', c: '#6B6B6B' }, { o: '0.75', c: '#9C9C9C' }, { o: '0.9', c: '#C8C8C8' }, { o: '1', c: '#EFEFEF' }
  ],
  shinyMetal: [
    { o: '0', c: '#FFFFFF' }, { o: '0.05', c: '#E8E8E8' }, { o: '0.15', c: '#9A9A9A' }, { o: '0.3', c: '#3D3D3D' },
    { o: '0.45', c: '#EDEDED' }, { o: '0.62', c: '#4A4A4A' }, { o: '0.84', c: '#B4B4B4' }, { o: '1', c: '#FFFFFF' }
  ],
  chrome: [
    { o: '0', c: '#FFFFFF' }, { o: '0.09', c: '#D2E2EE' }, { o: '0.22', c: '#3C4A54' }, { o: '0.35', c: '#FFFFFF' },
    { o: '0.5', c: '#8FA4B4' }, { o: '0.66', c: '#1E262C' }, { o: '0.82', c: '#C3D2DC' }, { o: '1', c: '#FFFFFF' }
  ],
  steel: [
    { o: '0', c: '#F0F4F6' }, { o: '0.07', c: '#B8C4CB' }, { o: '0.2', c: '#5C6B75' }, { o: '0.38', c: '#2B353C' },
    { o: '0.56', c: '#36424A' }, { o: '0.75', c: '#6E7D87' }, { o: '0.9', c: '#A9B7BF' }, { o: '1', c: '#DCE4E8' }
  ],
  brass: [
    { o: '0', c: '#F8ECC8' }, { o: '0.07', c: '#D9BC7E' }, { o: '0.2', c: '#8A6B2E' }, { o: '0.38', c: '#4A3714' },
    { o: '0.56', c: '#5C4519' }, { o: '0.75', c: '#9A7A36' }, { o: '0.9', c: '#CBAE6E' }, { o: '1', c: '#EEDDA8' }
  ],
  gold: [
    { o: '0', c: '#FFF6D0' }, { o: '0.07', c: '#F0D273' }, { o: '0.2', c: '#B8891F' }, { o: '0.38', c: '#6E4F0C' },
    { o: '0.56', c: '#87620F' }, { o: '0.75', c: '#C99C2C' }, { o: '0.9', c: '#EFD177' }, { o: '1', c: '#FFF3C4' }
  ],
  tiltedGray: [
    { o: '0', c: '#FAFAFA' }, { o: '0.1', c: '#D0D0D0' }, { o: '0.26', c: '#8C8C8C' }, { o: '0.44', c: '#6A6A6A' },
    { o: '0.62', c: '#8C8C8C' }, { o: '0.8', c: '#BFBFBF' }, { o: '1', c: '#F2F2F2' }
  ],
  tiltedBlack: [
    { o: '0', c: '#D8D8D8' }, { o: '0.1', c: '#6E6E6E' }, { o: '0.26', c: '#161616' }, { o: '0.44', c: '#000000' },
    { o: '0.62', c: '#141414' }, { o: '0.8', c: '#3A3A3A' }, { o: '1', c: '#9A9A9A' }
  ],
  glossyMetal: [
    { o: '0', c: '#FFFFFF' }, { o: '0.12', c: '#F2F2F2' }, { o: '0.28', c: '#C6C6C6' }, { o: '0.46', c: '#9E9E9E' },
    { o: '0.6', c: '#E4E4E4' }, { o: '0.8', c: '#FBFBFB' }, { o: '1', c: '#FFFFFF' }
  ]
};

@Component({
  selector: 'widget-sea-horizon',
  templateUrl: './widget-sea-horizon.component.html',
  styleUrls: ['./widget-sea-horizon.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetSeaHorizonComponent implements AfterViewInit {
  // Host2 inputs
  public id = input.required<string>();
  public type = input.required<string>();
  public theme = input.required<ITheme | null>();

  protected readonly runtime = inject(WidgetRuntimeDirective);
  private readonly streams = inject(WidgetStreamsDirective);

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

  protected readonly ready = signal(false);

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
  protected readonly glass = GLASS_ELLIPSE;
  protected readonly lcdHeel = LCD_HEEL;
  protected readonly lcdTrim = LCD_TRIM;
  protected readonly frameR = FRAME_R;
  protected readonly bevelR = BEVEL_R;
  protected readonly gapR = GAP_R;
  protected readonly faceR = FACE_R;
  protected readonly winR = WIN_R;
  protected readonly cx = CX;
  protected readonly cy = CY;

  // ---- configuration-derived geometry --------------------------------------
  /** "Show Frame" binds straight to noFrameVisible, so true means draw the bezel. */
  protected readonly frameVisible = computed(() => this.runtime.options()?.gauge?.noFrameVisible ?? false);

  /** With the bezel hidden the dial grows into the space the bezel would have occupied. */
  protected readonly dialTransform = computed(() =>
    this.frameVisible() ? null : `translate(${CX} ${CY}) scale(${NO_FRAME_SCALE}) translate(${-CX} ${-CY})`
  );

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

  protected readonly frameStops = computed<IGradientStop[]>(() => {
    const key = this.runtime.options()?.gauge?.faceColor ?? DEFAULT_FRAME_DESIGN;
    return FRAME_DESIGNS[key] ?? FRAME_DESIGNS[DEFAULT_FRAME_DESIGN];
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
      frame: `skh-frame-${suffix}`,
      bevel: `skh-bevel-${suffix}`,
      face: `skh-face-${suffix}`,
      sky: `skh-sky-${suffix}`,
      sea: `skh-sea-${suffix}`,
      glass: `skh-glass-${suffix}`,
      lcd: `skh-lcd-${suffix}`,
      window: `skh-window-${suffix}`
    };
  });

  protected readonly url = computed(() => {
    const r = this.ids();
    return {
      frame: `url(#${r.frame})`, bevel: `url(#${r.bevel})`, face: `url(#${r.face})`,
      sky: `url(#${r.sky})`, sea: `url(#${r.sea})`, glass: `url(#${r.glass})`,
      lcd: `url(#${r.lcd})`, window: `url(#${r.window})`
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
        }
        if (!pathCfg?.path) return;
        this.streams.observe('gaugePitchPath', pkt => {
          this.rawPitch.set(this.damp(this.rawPitch(), pkt?.data?.value as number | null | undefined, 'pitch'));
        }, 'pitch');
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
        }
        if (!pathCfg?.path) return;
        this.streams.observe('gaugeRollPath', pkt => {
          this.rawRoll.set(this.damp(this.rawRoll(), pkt?.data?.value as number | null | undefined, 'roll'));
        }, 'roll');
      });
    });
  }

  ngAfterViewInit(): void {
    // Transitions stay off for the first paint, so the step from a level dial to the first real
    // reading is instant rather than a slow sweep up from zero.
    requestAnimationFrame(() => this.ready.set(true));
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
