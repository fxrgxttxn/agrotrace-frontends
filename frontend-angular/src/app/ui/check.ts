import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'label.at-check',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<input
      #box
      type="checkbox"
      [checked]="checked()"
      [indeterminate]="indeterminate()"
      [disabled]="disabled()"
      [attr.name]="name() ?? null"
      [attr.value]="value() ?? null"
      [attr.aria-label]="ariaLabel() ?? null"
      [attr.aria-invalid]="invalid() ? 'true' : null"
      [attr.aria-describedby]="describedBy() ?? null"
      (change)="toggled.emit(box.checked)"
    />
    @if (label() !== undefined) {
      <span>{{ label() }}</span>
    }`,
})
export class CheckboxComponent {
  readonly label = input<string | undefined>(undefined);
  readonly checked = input(false);
  readonly indeterminate = input(false);
  readonly disabled = input(false);
  readonly name = input<string | undefined>(undefined);
  readonly value = input<string | undefined>(undefined);
  readonly ariaLabel = input<string | undefined>(undefined);
  readonly invalid = input(false);
  readonly describedBy = input<string | null | undefined>(undefined);
  readonly toggled = output<boolean>();
}

@Component({
  selector: 'label.at-radio',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<input
      type="radio"
      [checked]="checked()"
      [disabled]="disabled()"
      [attr.name]="name()"
      [attr.value]="value()"
      [attr.aria-invalid]="invalid() ? 'true' : null"
      [attr.aria-describedby]="describedBy() ?? null"
      (change)="picked.emit(value())"
    /><span>{{ label() }}</span>`,
})
export class RadioComponent {
  readonly label = input.required<string>();
  readonly name = input.required<string>();
  readonly value = input.required<string>();
  readonly checked = input(false);
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly describedBy = input<string | undefined>(undefined);
  readonly picked = output<string>();
}

@Component({
  selector: 'button.at-switch',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content />`,
  host: {
    type: 'button',
    role: 'switch',
    '[attr.aria-checked]': "checked() ? 'true' : 'false'",
    '[disabled]': 'disabled()',
    '(click)': 'toggled.emit(!checked())',
  },
})
export class SwitchComponent {
  readonly checked = input.required<boolean>();
  readonly disabled = input(false);
  readonly toggled = output<boolean>();
}
