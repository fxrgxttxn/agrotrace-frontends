// Thin React wrappers of the «Поле» design system: markup exactly as packages/design-system/README.md
// (test/ui/readme-dom.test.tsx compares the DOM with the README examples).
export { Icon, type IconName } from './Icon';
export { Button, ButtonLink, ButtonAnchor, type ButtonProps, type ButtonLook } from './Button';
export { Field, FieldSet, CellField, useFieldControl } from './Field';
export { Input, Textarea, InputGroup, Select, type InputProps } from './Input';
export { Checkbox, Radio, Switch } from './Check';
export { DateInput, dateErrorText, type DateError, type DateInputProps } from './DateInput';
export { Combobox, highlight, SEARCH_DELAY_MS, type ComboOption, type ComboboxProps } from './Combobox';
export { FileField, type FileItem, type FileFieldProps } from './FileField';
export {
  Spinner,
  Chip,
  Skeleton,
  Avatar,
  initials,
  Metric,
  sparkPoints,
  Progress,
  Stepper,
  Timeline,
  Card,
  CardHeader,
  CardBody,
  CardFacts,
  CardFooter,
  type Tone,
  type TimelineEntry,
} from './Display';
export { Illustration, Empty, illustrationMarkup, type IllustrationName } from './Illustration';
export {
  Table,
  TablePrimary,
  parseSort,
  formatSort,
  type Column,
  type SortState,
  type TableProps,
  type TableSelection,
} from './Table';
export { Pagination, pageWindow } from './Pagination';
export { Tabs, type TabDef } from './Tabs';
export { Dialog, type DialogProps } from './Dialog';
export { ToastProvider, useToast, TOAST_HIDE_MS, type ToastInput, type ToastTone } from './Toasts';
export { Page, PageLoading } from './Page';
export { Qr, qrPath } from './Qr';
export { PageToolbar, SEARCH_INPUT_DELAY_MS, useWide, type ToolbarSearch } from './Toolbar';
export { LoadFailed, AreaLoading, ListChanged } from './States';
