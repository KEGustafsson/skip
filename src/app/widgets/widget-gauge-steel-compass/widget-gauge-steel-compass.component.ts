import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { GaugeSteelComponent } from '../gauge-steel/gauge-steel.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective, widgetPathSignature, normalizeWidgetPath } from '../../core/directives/widget-streams.directive';
import { ITheme } from '../../core/services/app-service';

/**
 * Map any angle onto the compass card's [0, 360) domain.
 *
 * Applied to every reading rather than to a list of known signed paths: a card has no negative half,
 * so a value below zero can only be the port-side convention Signal K uses for relative angles
 * (apparent wind on this dial is a legitimate, if unusual, choice), and a value past 360 can only be
 * an accumulated turn. Both have exactly one sensible place on the card.
 */
export function toCompassDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Steel compass: a rotating card under a fixed pointer, in the Classic Steel idiom.
 *
 * The library's `Compass` carries no LCD, title or unit string — it is a bare 0-360 card — so the
 * digital heading is a DOM overlay sized against the dial's own box, not something the canvas draws.
 */
@Component({
  selector: 'widget-gauge-steel-compass',
  templateUrl: './widget-gauge-steel-compass.component.html',
  styleUrl: './widget-gauge-steel-compass.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GaugeSteelComponent]
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
      subType: 'compass',
      rotateFace: true,
      degreeScale: true,
      roseVisible: false,
      backgroundColor: 'carbon',
      faceColor: 'blackMetal'
    },
    updateInterval: 500,
    enableTimeout: false,
    dataTimeout: 5
  };

  /** Heading in degrees on [0, 360), or null while nothing has been received on the path. */
  protected readonly heading = signal<number | null>(null);

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
    if (/Magnetic$/.test(path)) return '°M';
    // headingTrue and courseOverGroundTrue, plus the qualified wind angles: angleTrueWater,
    // angleTrueWaterDamped, angleTrueGround.
    if (/True[A-Za-z]*$/.test(path)) return '°T';
    return '°';
  });

  /**
   * Identity of the path the reading describes: `undefined` before the first effect run, `null` for
   * a config with no usable path, the signature otherwise. See {@link clearReadingOnRepoint}.
   */
  private lastPathSignature: string | null | undefined = undefined;

  /**
   * Drop the reading when the widget is re-pointed at another path.
   *
   * `suppressBootstrapNull` filters the replayed leading null on every rebuilt subscription, so
   * against a path that reports nothing the stream callback never runs — and the previous path's
   * heading would stay on the card, presented as a live reading of the new one (#585). Clearing
   * unconditionally is equally wrong: this effect also re-runs on unrelated config edits, which
   * would blink the card back to its no-data state each time.
   */
  private clearReadingOnRepoint(signature: string | null): void {
    if (this.lastPathSignature !== undefined && this.lastPathSignature !== signature) {
      this.heading.set(null);
    }
    this.lastPathSignature = signature;
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
          // A non-numeric reading would otherwise print "NaN" on the LCD and leave the pointer
          // where it was: a misconfigured source is a no-reading, the same as a null.
          this.heading.set(Number.isFinite(raw) ? toCompassDegrees(raw as number) : null);
        });
      });
    });
  }
}
