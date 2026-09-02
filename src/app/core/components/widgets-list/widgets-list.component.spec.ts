import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetsListComponent } from './widgets-list.component';
import type { WidgetDescriptionWithPluginStatus } from '../../services/widget.service';

describe('WidgetsListComponent', () => {
  let component: WidgetsListComponent;
  let fixture: ComponentFixture<WidgetsListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WidgetsListComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(WidgetsListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('onSelectWidget', () => {
    // onSelectWidget rebuilds the WidgetDescription field by field, so every dependency list has to
    // be threaded through by hand. A dropped one leaves the dashboard's add-time gate blind to it.
    const selected = {
      name: 'Autopilot Head',
      description: 'Autopilot controls',
      icon: 'autopilotWidget',
      minWidth: 3,
      minHeight: 9,
      defaultWidth: 4,
      defaultHeight: 10,
      category: 'Component',
      requiredPlugins: [],
      anyOfPlugins: ['autopilot'],
      anyOfApis: ['/signalk/v2/api/vessels/self/autopilots'],
      selector: 'widget-autopilot',
      componentClassName: 'WidgetAutopilotComponent',
      isDependencyValid: true,
      pluginsStatus: [{ name: 'autopilot', enabled: false, required: false }]
    } as WidgetDescriptionWithPluginStatus;

    const select = (widget: WidgetDescriptionWithPluginStatus) => (component as unknown as {
      onSelectWidget: (w: WidgetDescriptionWithPluginStatus) => void;
    }).onSelectWidget(widget);

    it('carries both dependency lists through to the dialog result', () => {
      const close = vi.spyOn(TestBed.inject(MatDialogRef), 'close');

      select(selected);

      expect(close).toHaveBeenCalledWith(expect.objectContaining({
        selector: 'widget-autopilot',
        anyOfPlugins: ['autopilot'],
        anyOfApis: ['/signalk/v2/api/vessels/self/autopilots']
      }));
    });

    it('omits the dependency lists a widget does not declare', () => {
      const close = vi.spyOn(TestBed.inject(MatDialogRef), 'close');

      select({ ...selected, anyOfPlugins: undefined, anyOfApis: undefined });

      const result = close.mock.lastCall?.[0] as Record<string, unknown>;
      expect(result).toBeDefined();
      expect('anyOfPlugins' in result).toBe(false);
      expect('anyOfApis' in result).toBe(false);
    });

    it('ignores a widget whose dependencies are unmet', () => {
      const close = vi.spyOn(TestBed.inject(MatDialogRef), 'close');

      select({ ...selected, isDependencyValid: false });

      expect(close).not.toHaveBeenCalled();
    });
  });
});
