// Angular wrappers of the «Поле» design system. Each wrapper's host IS the README element (selectors such as
// `button.at-button`, `div.at-field`), so the DOM is exactly the README markup — no extra host elements
// (test/ui/readme-dom.test.ts compares it with packages/design-system/README.md).
export { LinkDirective } from './link';
export { ButtonComponent, type ButtonVariant } from './button';
export {
  FieldContext,
  FieldComponent,
  FieldSetComponent,
  FieldControlDirective,
  InputGroupComponent,
} from './field';
export { CheckboxComponent, RadioComponent, SwitchComponent } from './check';
export { DateInputComponent, dateErrorText, type DateError } from './date';
export { ComboboxComponent, highlight, SEARCH_DELAY_MS, type ComboOption } from './combobox';
export { FileFieldComponent, type FileItem } from './file-field';
export {
  SpinnerComponent,
  ChipComponent,
  SkeletonComponent,
  AvatarComponent,
  initials,
  MetricComponent,
  sparkPoints,
  ProgressComponent,
  StepperComponent,
  TimelineComponent,
  CardComponent,
  CardHeaderComponent,
  CardFactsComponent,
  type CardFact,
  type Tone,
  type TimelineEntry,
} from './display';
export { IllustrationComponent, ILLUSTRATIONS, type IllustrationName } from './illustrations.generated';
export {
  TableComponent,
  TableMobileBarComponent,
  TablePrimaryComponent,
  ColumnDirective,
  RowActionsDirective,
  parseSort,
  formatSort,
  type SortState,
  type TableSelection,
} from './table';
export { PaginationComponent, pageWindow } from './pagination';
export { TabsComponent, TabPanelDirective, type TabDef } from './tabs';
export { DialogComponent } from './dialog';
export {
  ToastService,
  ToastsComponent,
  ToastComponent,
  TOAST_HIDE_MS,
  type ToastInput,
  type ToastTone,
} from './toasts';
export { PageHeaderComponent, PageLoadingComponent, EmptyComponent } from './page';

import { LinkDirective } from './link';
import { ButtonComponent } from './button';
import { FieldComponent, FieldSetComponent, FieldControlDirective, InputGroupComponent } from './field';
import { CheckboxComponent, RadioComponent, SwitchComponent } from './check';
import { DateInputComponent } from './date';
import { ComboboxComponent } from './combobox';
import { FileFieldComponent } from './file-field';
import {
  SpinnerComponent,
  ChipComponent,
  SkeletonComponent,
  AvatarComponent,
  MetricComponent,
  ProgressComponent,
  StepperComponent,
  TimelineComponent,
  CardComponent,
  CardHeaderComponent,
  CardFactsComponent,
} from './display';
import { IllustrationComponent } from './illustrations.generated';
import {
  TableComponent,
  TableMobileBarComponent,
  TablePrimaryComponent,
  ColumnDirective,
  RowActionsDirective,
} from './table';
import { PaginationComponent } from './pagination';
import { TabsComponent, TabPanelDirective } from './tabs';
import { DialogComponent } from './dialog';
import { ToastsComponent } from './toasts';
import { PageHeaderComponent, PageLoadingComponent, EmptyComponent } from './page';

/** Every wrapper, for a template's `imports`. */
export const UI = [
  LinkDirective,
  ButtonComponent,
  FieldComponent,
  FieldSetComponent,
  FieldControlDirective,
  InputGroupComponent,
  CheckboxComponent,
  RadioComponent,
  SwitchComponent,
  DateInputComponent,
  ComboboxComponent,
  FileFieldComponent,
  SpinnerComponent,
  ChipComponent,
  SkeletonComponent,
  AvatarComponent,
  MetricComponent,
  ProgressComponent,
  StepperComponent,
  TimelineComponent,
  CardComponent,
  CardHeaderComponent,
  CardFactsComponent,
  IllustrationComponent,
  TableComponent,
  TableMobileBarComponent,
  TablePrimaryComponent,
  ColumnDirective,
  RowActionsDirective,
  PaginationComponent,
  TabsComponent,
  TabPanelDirective,
  DialogComponent,
  ToastsComponent,
  PageHeaderComponent,
  PageLoadingComponent,
  EmptyComponent,
] as const;
