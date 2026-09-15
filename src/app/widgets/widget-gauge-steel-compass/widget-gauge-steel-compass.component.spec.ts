import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WidgetSteelCompassComponent, toCompassDegrees } from './widget-gauge-steel-compass.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { UnitsService } from '../../core/services/units.service';
import { IPathUpdate } from '../../core/services/data.service';
import { IWidgetSvcConfig, IPathArray } from '../../core/interfaces/widgets-interface';

/**
 * The card itself is drawn by steelseries, which cannot acquire a 2D context under jsdom — so these
 * assert the decisions this component actually makes: what the LCD reads, what the card is fed, and
 * what happens to a stale reading when the path changes. Both host directives are faked; the child
 * gauge's UnitsService is a non-root service and has to be provided here.
 */
describe('WidgetSteelCompassComponent', () => {
  let fixture: ComponentFixture<WidgetSteelCompassComponent>;
  let internals: CompassInternals;
  let capturedNext: ((u: IPathUpdate) => void) | undefined;
  let options: WritableSignal<IWidgetSvcConfig | undefined>;

  interface CompassInternals {
    heading: () => number | null;
    headingText: () => string;
    unitLabel: () => string;
    displayName: () => string;
  }

  const makeConfig = (path: string | null = 'self.navigation.headingMagnetic'): IWidgetSvcConfig => {
    const dflt = WidgetSteelCompassComponent.DEFAULT_CONFIG;
    const gaugePath = (dflt.paths as IPathArray)['gaugePath'];
    return { ...dflt, paths: { gaugePath: { ...gaugePath, path } } };
  };

  const update = (value: unknown): IPathUpdate =>
    ({ data: { value, timestamp: null }, state: 'normal' }) as unknown as IPathUpdate;

  beforeEach(async () => {
    capturedNext = undefined;
    options = signal<IWidgetSvcConfig | undefined>(makeConfig());
    const streamsFake = {
      observe(_pathName: string, next: (u: IPathUpdate) => void) {
        capturedNext = next;
      }
    };
    const unitsFake = {
      getUnitDisplaySymbol: (measure: string | null | undefined): string => measure ?? '',
      convertToUnit: (_unit: string, value: number): number => value
    };

    await TestBed.configureTestingModule({
      imports: [WidgetSteelCompassComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        { provide: WidgetStreamsDirective, useValue: streamsFake },
        { provide: UnitsService, useValue: unitsFake }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(WidgetSteelCompassComponent);
    fixture.componentRef.setInput('id', 'steel-compass-1');
    fixture.componentRef.setInput('type', 'widget-gauge-steel-compass');
    fixture.componentRef.setInput('theme', { contrast: '#ffffff' });
    fixture.detectChanges();
    internals = fixture.componentInstance as unknown as CompassInternals;
  });

  it('shows no reading until a value arrives, so the card resting on 000 is not read as north', () => {
    expect(internals.heading()).toBeNull();
    expect(internals.headingText()).toBe('---');
  });

  it('pads the heading to three digits', () => {
    capturedNext?.(update(47.4));
    expect(internals.headingText()).toBe('047');
  });

  it('rounds 359.7 to 000 rather than to a 360 the card has no room for', () => {
    capturedNext?.(update(359.7));
    expect(internals.headingText()).toBe('000');
  });

  it('treats a non-numeric reading as no reading at all', () => {
    capturedNext?.(update(47));
    // A source publishing a non-numeric value would otherwise read as "NaN" on the LCD while the
    // pointer stayed on the last real heading.
    capturedNext?.(update(Number.NaN));

    expect(internals.heading()).toBeNull();
    expect(internals.headingText()).toBe('---');
  });

  it('drops the previous path reading when the widget is re-pointed', () => {
    capturedNext?.(update(47));
    expect(internals.heading()).toBe(47);

    // The new path reports nothing: suppressBootstrapNull filters its replayed leading null, so the
    // stream callback never runs and only the re-point clear can remove the old heading.
    options.set(makeConfig('self.navigation.courseOverGroundTrue'));
    fixture.detectChanges();

    expect(internals.heading()).toBeNull();
    expect(internals.headingText()).toBe('---');
  });

  it('keeps the reading across an unrelated config edit on the same path', () => {
    capturedNext?.(update(47));
    options.set({ ...makeConfig(), displayName: 'Ship Heading' });
    fixture.detectChanges();

    expect(internals.heading()).toBe(47);
    expect(internals.displayName()).toBe('Ship Heading');
  });

  it('names the reference the heading is measured against, from the path', () => {
    expect(internals.unitLabel()).toBe('°M');

    options.set(makeConfig('self.navigation.headingTrue'));
    fixture.detectChanges();
    expect(internals.unitLabel()).toBe('°T');

    options.set(makeConfig('self.environment.wind.angleApparent'));
    fixture.detectChanges();
    expect(internals.unitLabel()).toBe('°');
  });

  it('defaults to a rotating card fed degrees off a radian path', () => {
    const cfg = WidgetSteelCompassComponent.DEFAULT_CONFIG;
    const gaugePath = (cfg.paths as IPathArray)['gaugePath'];
    // subType drives which steelseries class the shared gauge builds; the rest is what makes the
    // card show the heading in degrees at the top of the dial.
    expect(cfg.gauge?.subType).toBe('compass');
    expect(cfg.gauge?.rotateFace).toBe(true);
    expect(gaugePath.pathSkUnitsFilter).toBe('rad');
    expect(gaugePath.convertUnitTo).toBe('deg');
    expect(gaugePath.suppressBootstrapNull).toBe(true);
  });
});

describe('toCompassDegrees', () => {
  it('maps a port-side negative angle onto the card', () => {
    expect(toCompassDegrees(-45)).toBe(315);
    expect(toCompassDegrees(-180)).toBe(180);
  });

  it('wraps an accumulated turn back onto the card', () => {
    expect(toCompassDegrees(370)).toBe(10);
  });

  it('leaves a heading already on the card alone', () => {
    expect(toCompassDegrees(0)).toBe(0);
    expect(toCompassDegrees(359.5)).toBe(359.5);
  });
});
