import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { t } from '../i18n';
import type { ThemeChoice } from '../theme';
import { ThemeService } from '../theme.service';
import { RadioComponent } from '../ui';

const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];

@Component({
  selector: 'fieldset.at-field[themeSwitch]',
  standalone: true,
  imports: [RadioComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<legend class="at-field__label">{{ t('theme.label') }}</legend>
    <div class="at-field__options" data-direction="row">
      @for (choice of themes; track choice) {
        <label
          class="at-radio"
          [name]="'theme'"
          [value]="choice"
          [label]="t('theme.' + choice)"
          [checked]="theme.choice() === choice"
          (picked)="theme.set(choice)"
        ></label>
      }
    </div>`,
})
export class ThemeSwitchComponent {
  protected readonly t = t;
  protected readonly themes = THEMES;
  protected readonly theme = inject(ThemeService);
  readonly themeSwitch = input(true);
}
