import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { t } from '../app/i18n';
import { SessionService } from '../app/session';
import { ThemeSwitchComponent } from '../app/shell/theme-switch';
import { UI } from '../app/ui';

/** `/profile` — for now the theme switch and «Выйти» (the profile itself arrives with A2). */
@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...UI, ThemeSwitchComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.profile')">
      <div class="at-page__actions">
        <button class="at-button" [icon]="'logout'" (click)="signOut()">{{ t('action.logout') }}</button>
      </div>
    </div>
    <article class="at-card">
      <div class="at-card__body"><fieldset class="at-field" [themeSwitch]="true"></fieldset></div>
    </article>`,
})
export class ProfilePage {
  protected readonly t = t;
  private readonly session = inject(SessionService);

  protected signOut(): void {
    void this.session.signOut();
  }
}
