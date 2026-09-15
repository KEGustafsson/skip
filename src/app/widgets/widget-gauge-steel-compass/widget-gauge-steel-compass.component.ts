import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective, widgetPathSignature, normalizeWidgetPath, WidgetRepointTracker } from '../../core/directives/widget-streams.directive';
import { ITheme } from '../../core/services/app-service';

/** Material pair the card is drawn in. Keys are what a stored config carries. */
export interface ICompassFinish {
  /** Seven stops around the bezel ring, light to dark, giving it its turned-metal look. */
  bezel: readonly string[];
  /** Three stops of the dial face, centre outwards. */
  face: readonly string[];
  tick: string;
  tickMinor: string;
  label: string;
  dim: string;
  /** The index at the top of the dial, and north on the card. */
  index: string;
  lcdTop: string;
  lcdBottom: string;
  lcdInk: string;
  glass: string;
}

export const COMPASS_FINISHES: Readonly<Record<string, ICompassFinish>> = {
  anthracite: {
    bezel: ['#E9EDEF', '#98A0A4', '#2B2F31', '#0A0C0D', '#4E5457', '#BAC1C5', '#17191B'],
    face: ['#5C6265', '#34393B', '#14171A'],
    tick: '#F2F5F6', tickMinor: '#9BA3A7', label: '#FFFFFF', dim: '#98A1A5',
    index: '#D8232A',
    lcdTop: '#CBD0B4', lcdBottom: '#ADB598', lcdInk: '#20261F',
    glass: 'rgba(255,255,255,.085)'
  },
  stainless: {
    bezel: ['#FBFCFC', '#C6CDD1', '#7C8489', '#454B4F', '#A9B1B5', '#EDF1F2', '#6B7276'],
    face: ['#F0F2EE', '#D6DAD4', '#A8AEA9'],
    tick: '#1A1F22', tickMinor: '#5D666B', label: '#11161A', dim: '#4B5559',
    index: '#B01118',
    lcdTop: '#B9C1A4', lcdBottom: '#9AA488', lcdInk: '#1B211A',
    glass: 'rgba(255,255,255,.22)'
  },
  carbon: {
    bezel: ['#7E868A', '#3B4145', '#15181A', '#000000', '#2E3438', '#767E82', '#0B0D0E'],
    face: ['#22272A', '#14181A', '#050708'],
    tick: '#E6EBED', tickMinor: '#79838A', label: '#FFFFFF', dim: '#8C969B',
    index: '#E8353C',
    lcdTop: '#8E9A7E', lcdBottom: '#727E63', lcdInk: '#14180F',
    glass: 'rgba(255,255,255,.06)'
  },
  night: {
    bezel: ['#6E7478', '#2E3437', '#101314', '#000000', '#272C2F', '#5F676B', '#0A0C0D'],
    face: ['#241012', '#170A0C', '#080405'],
    tick: '#FF6B66', tickMinor: '#9B3B3A', label: '#FF8A85', dim: '#A34744',
    index: '#FF5A52',
    lcdTop: '#4A1E1D', lcdBottom: '#341413', lcdInk: '#FF9A93',
    glass: 'rgba(255,120,110,.06)'
  }
};

interface ICardTick { x1: number; y1: number; x2: number; y2: number; stroke: string; width: number }
interface ICardLabel { x: number; y: number; text: string; size: number; weight: number; fill: string; rotate: string }

/** Dial geometry, in the 500x500 viewBox every coordinate below is expressed in. */
const CX = 250;
const CY = 250;
const R_CARD = 190;

function point(radius: number, angleDeg: number): [number, number] {
  const t = (angleDeg - 90) * Math.PI / 180;
  return [CX + radius * Math.cos(t), CY + radius * Math.sin(t)];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Map any angle onto the compass card's [0, 360) domain.
 *
 * Applied to every reading rather than to a list of known signed paths: a card has no negative half,
 * so a value below zero can only be the port-side convention Signal K uses for relative angles, and
 * a value past 360 can only be an accumulated turn. Both have exactly one sensible place.
 */
export function toCompassDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * The turn from one heading to another, as the card actually swings it: the shorter way round,
 * signed. Passing 359 -> 001 to a CSS rotation unchanged would spin the card 358 degrees backwards
 * through south; this returns +2.
 */
export function shortestTurn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Steel compass: the card turns under a fixed index at the rim, the way a binnacle compass reads.
 * That is the only mode — there is no needle on this dial in any configuration.
 *
 * Drawn here rather than by the bundled steelseries library. That library's `Compass` can rotate its
 * card, but its index is always a full needle from the hub outwards — and a needle on a compass
 * reads as a magnetic needle pointing north, not as the lubber line you steer against. None of its
 * sixteen pointer types is a rim index and it rejects a transparent pointer, so the card is ours.
 */
@Component({
  selector: 'widget-gauge-steel-compass',
  templateUrl: './widget-gauge-steel-compass.component.html',
  styleUrl: './widget-gauge-steel-compass.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class WidgetSteelCompassComponent {
  // Functional Host2 inputs
  public id = input.required<string>();
  public type = input.required<string>();
  public theme = input.required<ITheme | null>();

  // Host directives
  protected readonly runtime = inject(WidgetRuntimeDirective);
  private readonly streams = inject(WidgetStreamsDirective);

  public static readonly DEFAULT_CONFIG: IWidgetSvcConfig = {
    displayName: 'Heading',
    filterSelfPaths: true,
    supportAutomaticHistoricalSeries: true,
    paths: {
      gaugePath: {
        description: 'Heading',
        path: null,
        source: null,
        pathType: 'number',
        suppressBootstrapNull: true,
        isPathConfigurable: true,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        showConvertUnitTo: false,
        convertUnitTo: 'deg'
      }
    },
    gauge: {
      type: 'steelCompass',
      degreeScale: true,
      finish: 'anthracite'
    },
    updateInterval: 500,
    enableTimeout: false,
    dataTimeout: 5
  };

  /** Heading in degrees on [0, 360), or null while nothing has been received on the path. */
  protected readonly heading = signal<number | null>(null);

  /**
   * Heading as an unbounded angle: every update adds the shorter turn rather than jumping to the
   * new value, so the CSS transition on the card always takes the short way round north.
   */
  private readonly turned = signal(0);

  protected readonly displayName = computed(() => this.runtime.options()?.displayName ?? '');

  /** Three digits, or `---` with no reading: a card parked on 000 is indistinguishable from north. */
  protected readonly headingText = computed(() => {
    const value = this.heading();
    if (value === null) return '---';
    // Rounded first, so 359.7 reads as 000 rather than 360.
    return String(Math.round(value) % 360).padStart(3, '0');
  });

  /**
   * The reference the number is measured against, read off the path itself. A heading gauge that
   * doesn't say magnetic or true is a heading gauge you have to go and check.
   */
  protected readonly unitLabel = computed(() => {
    const path = normalizeWidgetPath(this.runtime.options()?.paths?.['gaugePath']?.path) ?? '';
    // Only a bearing measured from north earns the reference letter: headingMagnetic,
    // courseOverGroundTrue, directionTrue, nextPoint.bearingTrue. "True" in a wind angle names the
    // velocity frame, not the reference — angleTrueWater is 45° off the bow, not 045 true — and
    // those paths end in Water, Ground or Damped, so the anchored match leaves them plain.
    if (/Magnetic$/.test(path)) return '°M';
    if (/True$/.test(path)) return '°T';
    return '°';
  });

  protected readonly finish = computed<ICompassFinish>(() => {
    const key = this.runtime.options()?.gauge?.finish ?? 'anthracite';
    return COMPASS_FINISHES[key] ?? COMPASS_FINISHES['anthracite'];
  });

  /** Card rotation. Negative because the card turns against the heading to bring it under the index. */
  protected readonly cardRotation = computed(() => -this.turned());

  /** Unique per instance: two compasses on one dashboard must not share gradient ids. */
  protected readonly gradientId = computed(() => `sc-${this.id()}`);

  protected readonly bezelStops = computed(() =>
    this.finish().bezel.map((color, i) => ({ color, offset: [0, 0.13, 0.33, 0.55, 0.74, 0.89, 1][i] }))
  );

  protected readonly faceStops = computed(() =>
    this.finish().face.map((color, i) => ({ color, offset: [0, 0.56, 1][i] }))
  );

  protected readonly cardTicks = computed<ICardTick[]>(() => {
    const pal = this.finish();
    const ticks: ICardTick[] = [];
    for (let a = 0; a < 360; a += 5) {
      const major = a % 30 === 0;
      const mid = a % 10 === 0;
      const length = major ? 24 : mid ? 15 : 8;
      const [x1, y1] = point(R_CARD - length, a);
      const [x2, y2] = point(R_CARD, a);
      ticks.push({
        x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2),
        stroke: major ? pal.tick : pal.tickMinor,
        width: major ? 5 : mid ? 3 : 2
      });
    }
    return ticks;
  });

  protected readonly cardLabels = computed<ICardLabel[]>(() => {
    const pal = this.finish();
    const withDegrees = this.runtime.options()?.gauge?.degreeScale !== false;
    const cardinals: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    const inter: Record<number, string> = { 45: 'NE', 135: 'SE', 225: 'SW', 315: 'NW' };
    const labels: ICardLabel[] = [];

    const push = (radius: number, angle: number, text: string, size: number, weight: number, fill: string) => {
      const [x, y] = point(radius, angle);
      labels.push({
        x: round(x), y: round(y), text, size, weight, fill,
        // Upright against the card's own radius, as printed on a real card: the numbers at the
        // bottom of the dial read upside down, and that is what tells you the card has turned.
        rotate: `rotate(${round(angle)} ${round(x)} ${round(y)})`
      });
    };

    for (let a = 0; a < 360; a += 30) {
      const cardinal = cardinals[a];
      if (cardinal) {
        push(R_CARD - 48, a, cardinal, 40, 700, a === 0 ? pal.index : pal.label);
      } else if (withDegrees) {
        // The whole bearing: 30, 60, 120 — not the tens shorthand a printed card uses.
        push(R_CARD - 46, a, String(a), 26, 600, pal.label);
      }
    }
    for (const angle of [45, 135, 225, 315]) {
      push(R_CARD - 88, angle, inter[angle], 19, 600, pal.dim);
    }
    return labels;
  });

  /** Path identity behind the reading below; see {@link WidgetRepointTracker}. */
  private readonly repoint = new WidgetRepointTracker();

  /** Drop the reading when the widget is re-pointed at another path (#585). */
  private clearReadingOnRepoint(signature: string | null): void {
    if (!this.repoint.repointed(signature)) return;
    this.heading.set(null);
  }

  /** Apply a new heading, turning the card the short way round from wherever it is. */
  private applyHeading(value: number | null): void {
    this.heading.set(value);
    if (value === null) return;
    this.turned.update(current => current + shortestTurn(toCompassDegrees(current), value));
  }

  constructor() {
    effect(() => {
      const cfg = this.runtime.options();
      if (!cfg) return;
      const pathCfg = cfg.paths?.['gaugePath'];
      // Computed before the bail-out and null exactly when there is no usable path: the streams
      // directive drops the subscription in that case, so the reading has to go with it.
      const signature = widgetPathSignature(pathCfg);
      untracked(() => {
        this.clearReadingOnRepoint(signature);
        if (!signature) return;
        // A fresh closure on every run by design: the directive compares callback identity as well
        // as the signature, and a stable reference would early-return instead of replaying the
        // current value into a component that has just cleared itself.
        this.streams.observe('gaugePath', pkt => {
          const raw = (pkt?.data?.value as number) ?? null;
          // A non-numeric reading would otherwise print "NaN" on the LCD and leave the card where
          // it was: a misconfigured source is a no-reading, the same as a null.
          this.applyHeading(Number.isFinite(raw) ? toCompassDegrees(raw as number) : null);
        });
      });
    });
  }
}
