import { signal, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetSeaHorizonComponent } from './widget-sea-horizon.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective, widgetPathSignature } from '../../core/directives/widget-streams.directive';
import type { IPathUpdate } from '../../core/services/data.service';
import type { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';

/**
 * The widget draws itself entirely from computed geometry, so the assertions below read those
 * computeds rather than the rendered SVG: the decision is what is worth pinning, and a
 * transform string or a band arc is the decision in its final form.
 */
interface SeaHorizonInternals {
  frameVisible: () => boolean;
  dialTransform: () => string | null;
  cautionAngle: () => number;
  alarmAngle: () => number;
  heelBands: () => { d: string; fill: string }[];
  limitIndexes: () => { x1: number; y1: number; x2: number; y2: number }[];
  heelText: () => string;
  trimText: () => string;
  noData: () => boolean;
  worldTransform: () => string;
  pointerTransform: () => string;
  frameStops: () => { o: string; c: string }[];
  ready: () => boolean;
}

type StreamCallback = (packet: IPathUpdate) => void;

const ATTITUDE_PATHS = {
  gaugePitchPath: { path: 'self.navigation.attitude', pathType: 'number', convertUnitTo: 'deg', source: 'default' },
  gaugeRollPath: { path: 'self.navigation.attitude', pathType: 'number', convertUnitTo: 'deg', source: 'default' }
};

type GaugeOverrides = Partial<NonNullable<IWidgetSvcConfig['gauge']>>;

/**
 * A merged config as the runtime directive would hand it to the widget, with the gauge block
 * overridable per test. The specs provide it directly rather than leaning on DEFAULT_CONFIG, so a
 * test states the settings it depends on instead of inheriting them silently.
 */
function baseConfig(gauge: GaugeOverrides = {}): IWidgetSvcConfig {
  return {
    numDecimal: 1,
    updateInterval: 1000,
    paths: ATTITUDE_PATHS,
    gauge: { type: 'seaHorizon', ...gauge }
  } as unknown as IWidgetSvcConfig;
}

interface Harness {
  component: SeaHorizonInternals;
  fixture: ComponentFixture<WidgetSeaHorizonComponent>;
  options: WritableSignal<IWidgetSvcConfig | undefined>;
  /** Latest callback registered for a path key, so a test can push a reading through it. */
  emit: (pathKey: string, value: number | null) => void;
  observed: { pathName: string; subField?: string }[];
  /** The fake's live subscriptions, keyed by path. A new object means the pipeline was rebuilt. */
  subscriptions: () => Map<string, FakeSubscription>;
  /** How many times the fake has built a pipeline. Unchanged across a call it treats as a no-op. */
  rebuilds: () => number;
}

/** One live subscription in the fake, mirroring what the real directive keys a rebuild on. */
interface FakeSubscription { next: StreamCallback; subField?: string; signature: string; }

/**
 * Mount the widget against local fakes for the two host directives, and capture the stream
 * callbacks it registers so a test can push readings through them. Each call configures a testing
 * module, so a test comparing two mounts has to reset the module between them.
 */
function mount(config: IWidgetSvcConfig): Harness {
  const options = signal<IWidgetSvcConfig | undefined>(config);
  const callbacks = new Map<string, StreamCallback>();
  const observed: { pathName: string; subField?: string }[] = [];
  const subscriptions = new Map<string, FakeSubscription>();
  let rebuilds = 0;

  TestBed.configureTestingModule({
    imports: [WidgetSeaHorizonComponent],
    providers: [
      { provide: WidgetRuntimeDirective, useValue: { options } },
      {
        provide: WidgetStreamsDirective,
        useValue: {
          // Mirrors WidgetStreamsDirective.observe: an unchanged (signature, callback, sub-field)
          // triple is a no-op, anything else tears the pipeline down and rebuilds it. The real
          // widgetPathSignature is used so the fake cannot drift from the rule it models.
          observe: (pathName: string, next: StreamCallback, subField?: string) => {
            callbacks.set(pathName, next);
            observed.push({ pathName, subField });
            const signature = widgetPathSignature(options()?.paths?.[pathName]) ?? '';
            const live = subscriptions.get(pathName);
            if (live && live.signature === signature && live.next === next && live.subField === subField) return;
            subscriptions.set(pathName, { next, subField, signature });
            rebuilds++;
          }
        }
      }
    ]
  });

  const fixture = TestBed.createComponent(WidgetSeaHorizonComponent);
  fixture.componentRef.setInput('id', 'test-sea-horizon');
  fixture.componentRef.setInput('type', 'widget-sea-horizon');
  fixture.componentRef.setInput('theme', null);
  fixture.detectChanges();

  return {
    component: fixture.componentInstance as unknown as SeaHorizonInternals,
    fixture,
    options,
    observed,
    subscriptions: () => subscriptions,
    rebuilds: () => rebuilds,
    emit: (pathKey, value) => callbacks.get(pathKey)?.({ data: { value } } as unknown as IPathUpdate)
  };
}

describe('WidgetSeaHorizonComponent stream wiring', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('observes the whole navigation.attitude leaf and extracts pitch and roll', () => {
    const h = mount(baseConfig());
    expect(h.observed).toContainEqual({ pathName: 'gaugePitchPath', subField: 'pitch' });
    expect(h.observed).toContainEqual({ pathName: 'gaugeRollPath', subField: 'roll' });
  });

  it('renders heel and trim from the live readings', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 18.42);
    h.emit('gaugePitchPath', -2.6);
    expect(h.component.heelText()).toBe('18.4° STBD');
    expect(h.component.trimText()).toBe('TRIM −2.6°');
    expect(h.component.noData()).toBe(false);
  });

  it('names the low side rather than the sign, and calls a level boat level', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', -21);
    expect(h.component.heelText()).toBe('21.0° PORT');
    h.emit('gaugeRollPath', 0.1);
    expect(h.component.heelText()).toBe('0.1° LEVEL');
  });

  it('reports no data until a reading arrives, and again when one times out', () => {
    const h = mount(baseConfig());
    expect(h.component.noData()).toBe(true);
    expect(h.component.heelText()).toBe('--');

    h.emit('gaugeRollPath', 12);
    expect(h.component.noData()).toBe(false);

    // A stale-data timeout pushes a null through the same callback.
    h.emit('gaugeRollPath', null);
    expect(h.component.noData()).toBe(true);
    expect(h.component.heelText()).toBe('--');
  });

  // Issue #585: WidgetStreamsDirective rebuilds the subscription on a re-point, but
  // suppressBootstrapNull filters the replayed leading null. Against a path that reports nothing
  // the callback never runs, so a widget that does not clear on a signature change leaves the
  // previous path's reading on the dial as a live reading of the new one.
  it('clears the reading when the configured path changes', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 25);
    h.emit('gaugePitchPath', 4);
    expect(h.component.noData()).toBe(false);

    h.options.set({
      ...baseConfig(),
      paths: {
        gaugePitchPath: { ...ATTITUDE_PATHS.gaugePitchPath, source: 'imu-2' },
        gaugeRollPath: { ...ATTITUDE_PATHS.gaugeRollPath, source: 'imu-2' }
      }
    } as unknown as IWidgetSvcConfig);
    h.fixture.detectChanges();

    expect(h.component.noData()).toBe(true);
    expect(h.component.heelText()).toBe('--');
  });

  it('leaves the reading alone when an unrelated setting changes', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 25);

    h.options.set(baseConfig({ faceColor: 'chrome' }));
    h.fixture.detectChanges();

    expect(h.component.heelText()).toBe('25.0° STBD');
  });

  // WidgetStreamsDirective rebuilds a pipeline unless it is handed the same signature, callback and
  // sub-field, so a fresh closure per effect run would tear down and re-subscribe both paths on
  // every unrelated edit — replaying the last value through the damper and restarting the stale
  // window. The fake models that rule, so this asserts the pipelines survive rather than merely
  // that the callback reference happens to match.
  it('keeps both stream pipelines alive across unrelated config changes', () => {
    const h = mount(baseConfig());
    expect(h.rebuilds()).toBe(2);
    const pitch = h.subscriptions().get('gaugePitchPath');
    const roll = h.subscriptions().get('gaugeRollPath');

    h.options.set(baseConfig({ faceColor: 'chrome', damping: 3, invertRoll: true }));
    h.fixture.detectChanges();

    expect(h.rebuilds()).toBe(2);
    expect(h.subscriptions().get('gaugePitchPath')).toBe(pitch);
    expect(h.subscriptions().get('gaugeRollPath')).toBe(roll);
  });

  // The negative case: without it the test above would pass even if the fake could never observe a
  // rebuild at all.
  it('rebuilds both stream pipelines when the configured path changes', () => {
    const h = mount(baseConfig());
    expect(h.rebuilds()).toBe(2);

    h.options.set({
      ...baseConfig(),
      paths: {
        gaugePitchPath: { ...ATTITUDE_PATHS.gaugePitchPath, source: 'imu-2' },
        gaugeRollPath: { ...ATTITUDE_PATHS.gaugeRollPath, source: 'imu-2' }
      }
    } as unknown as IWidgetSvcConfig);
    h.fixture.detectChanges();

    expect(h.rebuilds()).toBe(4);
  });
});

describe('WidgetSeaHorizonComponent motion transitions', () => {
  // Frames are queued by hand so a test can tell "reading landed" apart from "frame after it".
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    TestBed.resetTestingModule();
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => undefined; });
  });
  afterEach(() => vi.unstubAllGlobals());
  const flushFrames = () => { const due = frames.splice(0); due.forEach(cb => cb(0)); };

  // The step from a level dial to the first real reading must be a snap, not a sweep up from zero,
  // so transitions are armed only once that reading has been drawn without one.
  it('paints the first reading without a transition and animates the ones after it', () => {
    const h = mount(baseConfig());
    expect(h.component.ready()).toBe(false);

    h.emit('gaugeRollPath', 18);
    expect(h.component.ready()).toBe(false);

    flushFrames();
    expect(h.component.ready()).toBe(true);
  });

  it('never arms transitions on a dial that has nothing to show', () => {
    const h = mount(baseConfig());
    flushFrames();
    expect(h.component.ready()).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('drops transitions when the reading is lost, so recovery snaps too', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 18);
    flushFrames();
    expect(h.component.ready()).toBe(true);

    h.emit('gaugeRollPath', null);
    expect(h.component.ready()).toBe(false);
  });

  it('drops transitions on a re-point, so the new path\'s first reading snaps', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 18);
    flushFrames();
    expect(h.component.ready()).toBe(true);

    h.options.set({
      ...baseConfig(),
      paths: {
        gaugePitchPath: { ...ATTITUDE_PATHS.gaugePitchPath, source: 'imu-2' },
        gaugeRollPath: { ...ATTITUDE_PATHS.gaugeRollPath, source: 'imu-2' }
      }
    } as unknown as IWidgetSvcConfig);
    h.fixture.detectChanges();

    expect(h.component.ready()).toBe(false);
  });

  it('cancels a pending arm when the reading is lost before the frame runs', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 18);
    h.emit('gaugeRollPath', null);
    flushFrames();
    expect(h.component.ready()).toBe(false);
  });
});

describe('WidgetSeaHorizonComponent axis inversion', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('applies the inversion flags to both axes', () => {
    const h = mount(baseConfig({ invertRoll: true, invertPitch: true }));
    h.emit('gaugeRollPath', 15);
    h.emit('gaugePitchPath', 3);
    expect(h.component.heelText()).toBe('15.0° PORT');
    expect(h.component.trimText()).toBe('TRIM −3.0°');
  });

  // The signals hold the raw reading and invert in a computed, so flipping an axis takes effect at
  // once instead of waiting for the next sample to arrive.
  it('re-reads the stored sample when an axis is flipped', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 15);
    expect(h.component.heelText()).toBe('15.0° STBD');

    h.options.set(baseConfig({ invertRoll: true }));
    h.fixture.detectChanges();

    expect(h.component.heelText()).toBe('15.0° PORT');
  });
});

describe('WidgetSeaHorizonComponent dial geometry', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // "Show Frame" binds straight to gauge.noFrameVisible with no inversion, so true means draw the
  // bezel. The dial scales up when it is off, to fill the space the bezel would have taken.
  it('draws the bezel and leaves the dial unscaled when Show Frame is on', () => {
    const h = mount(baseConfig({ noFrameVisible: true }));
    expect(h.component.frameVisible()).toBe(true);
    expect(h.component.dialTransform()).toBeNull();
  });

  it('hides the bezel and grows the dial when Show Frame is off', () => {
    const h = mount(baseConfig({ noFrameVisible: false }));
    expect(h.component.frameVisible()).toBe(false);
    expect(h.component.dialTransform()).toContain('scale(1.3)');
  });

  it('rotates the world against the boat, not the boat against the world', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 20);
    // Heeled 20° to starboard, the horizon tips 20° the other way.
    expect(h.component.worldTransform()).toContain('rotate(-20.00 150 150)');
    expect(h.component.pointerTransform()).toContain('rotate(20.00 150 150)');
  });

  it('translates the world for trim, bow-up moving the horizon down the window', () => {
    const h = mount(baseConfig());
    h.emit('gaugePitchPath', 5);
    expect(h.component.worldTransform()).toContain('translate(0 29.00)');
  });

  // The scale is only ruled to 45°; the index parks near the last mark rather than running round
  // the dial, while the horizon itself keeps rotating truthfully.
  it('parks the index at the end of the scale past 45° but keeps rotating the horizon', () => {
    const h = mount(baseConfig());
    h.emit('gaugeRollPath', 80);
    expect(h.component.pointerTransform()).toContain('rotate(48.00');
    expect(h.component.worldTransform()).toContain('rotate(-80.00');
  });

  it('falls back to a level dial when there is no reading', () => {
    const h = mount(baseConfig());
    expect(h.component.worldTransform()).toContain('rotate(0.00 150 150) translate(0 0.00)');
    expect(h.component.noData()).toBe(true);
  });
});

describe('WidgetSeaHorizonComponent heel bands', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('mirrors every band port and starboard', () => {
    const h = mount(baseConfig());
    // Three spans (nominal, caution, alarm), each drawn on both sides.
    expect(h.component.heelBands()).toHaveLength(6);
    expect(h.component.limitIndexes()).toHaveLength(2);
  });

  it('uses the configured caution and alarm angles', () => {
    const h = mount(baseConfig({ heelCautionAngle: 12, heelAlarmAngle: 24 }));
    expect(h.component.cautionAngle()).toBe(12);
    expect(h.component.alarmAngle()).toBe(24);
  });

  it('defaults to a cruising band when the angles are missing', () => {
    const h = mount(baseConfig());
    expect(h.component.cautionAngle()).toBe(20);
    expect(h.component.alarmAngle()).toBe(30);
  });

  // An alarm at or below the caution angle would collapse the caution band to zero width and start
  // the alarm before the caution it escalates from.
  it('keeps the alarm angle above the caution angle', () => {
    const h = mount(baseConfig({ heelCautionAngle: 25, heelAlarmAngle: 10 }));
    expect(h.component.alarmAngle()).toBe(26);
    expect(h.component.heelBands()).toHaveLength(6);
  });

  it('clamps angles to the ruled part of the scale', () => {
    const h = mount(baseConfig({ heelCautionAngle: 900, heelAlarmAngle: 900 }));
    expect(h.component.cautionAngle()).toBe(44);
    expect(h.component.alarmAngle()).toBe(45);
  });
});

describe('WidgetSeaHorizonComponent damping', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('passes samples straight through when damping is off', () => {
    const h = mount(baseConfig({ damping: 0 }));
    h.emit('gaugeRollPath', 10);
    h.emit('gaugeRollPath', 30);
    expect(h.component.heelText()).toBe('30.0° STBD');
  });

  it('takes the first sample verbatim rather than ramping up from zero', () => {
    const h = mount(baseConfig({ damping: 3 }));
    h.emit('gaugeRollPath', 22);
    expect(h.component.heelText()).toBe('22.0° STBD');
  });

  it('eases toward later samples with the configured time constant', () => {
    let clock = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const h = mount(baseConfig({ damping: 1 }));
    h.emit('gaugeRollPath', 0);
    clock += 1000; // one time constant later
    h.emit('gaugeRollPath', 10);

    // alpha = 1 - e^-1 = 0.632, so the dial moves most but not all of the way.
    expect(h.component.heelText()).toBe('6.3° STBD');
  });

  it('clears rather than smoothing when a reading goes away', () => {
    const h = mount(baseConfig({ damping: 3 }));
    h.emit('gaugeRollPath', 20);
    h.emit('gaugeRollPath', null);
    expect(h.component.heelText()).toBe('--');
  });
});

describe('WidgetSeaHorizonComponent bezel finishes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /** Each mount needs its own module, so finishes are captured one at a time and compared after. */
  function stopsFor(faceColor: string): { o: string; c: string }[] {
    TestBed.resetTestingModule();
    return mount(baseConfig({ faceColor })).component.frameStops();
  }

  it('uses the stored faceColor finish', () => {
    expect(stopsFor('brass')).not.toEqual(stopsFor('anthracite'));
  });

  it('falls back to anthracite for a finish it does not know', () => {
    expect(stopsFor('not-a-finish')).toEqual(stopsFor('anthracite'));
  });
});
