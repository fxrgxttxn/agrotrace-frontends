import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type IllustrationName =
  | 'empty-batches'
  | 'empty-complaints'
  | 'empty-fields'
  | 'empty-lab'
  | 'empty-notifications'
  | 'empty-recalls'
  | 'empty-search'
  | 'empty-waybills'
  | 'forbidden'
  | 'login'
  | 'not-found'
  | 'recall-warning';

export const ILLUSTRATIONS: readonly IllustrationName[] = ['empty-batches', 'empty-complaints', 'empty-fields', 'empty-lab', 'empty-notifications', 'empty-recalls', 'empty-search', 'empty-waybills', 'forbidden', 'login', 'not-found', 'recall-warning'];

const VIEW_BOX: Record<IllustrationName, string> = {
  'empty-batches': '0 0 240 160',
  'empty-complaints': '0 0 240 160',
  'empty-fields': '0 0 240 160',
  'empty-lab': '0 0 240 160',
  'empty-notifications': '0 0 240 160',
  'empty-recalls': '0 0 240 160',
  'empty-search': '0 0 240 160',
  'empty-waybills': '0 0 240 160',
  'forbidden': '0 0 240 160',
  'login': '0 0 240 160',
  'not-found': '0 0 240 160',
  'recall-warning': '0 0 240 160',
};

@Component({
  selector: 'svg[art]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[attr.viewBox]': 'viewBox()' },
  template: `@switch (art()) {
      @case ('empty-batches') {
          <svg:path d="M0 128L20 123.1L40 119.1L60 116L80 113.8L100 112.4L120 112L140 112.4L160 113.8L180 116L200 119.1L220 123.1L240 128L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 130L0 128L11.6 125.2ZM0 137.1L36.3 119.8L40 119.1L53.3 117L0 146.7ZM67.2 115.2L79.4 113.8L24 160L0 160ZM90.2 113.1L100 112.4L100.5 112.4L72 160L48 160ZM110.3 112.2L120 112L120 160L96 160ZM139.5 112.4L168 160L144 160L129.7 112.2ZM216 160L192 160L149.8 113.1L160 113.8L160.6 113.8ZM186.7 117L240 146.7L240 160L172.8 115.2L180 116ZM203.7 119.8L220 123.1L228.4 125.2L240 130L240 137.1Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:rect x="86" y="68" width="68" height="14" rx="3" [attr.style]="'fill: var(--c-straw)'"></svg:rect>
          <svg:rect x="78" y="80" width="84" height="50" rx="4" [attr.style]="'fill: var(--c-straw)'"></svg:rect>
          <svg:path d="M80 80h80M78 97h84M78 113h84" [attr.style]="'fill: none; stroke: var(--c-surface)'" stroke-width="3" stroke-linecap="butt" stroke-linejoin="round"></svg:path>
          <svg:rect x="110" y="102" width="20" height="6" rx="3" [attr.style]="'fill: var(--c-surface)'"></svg:rect>
        }
      @case ('empty-complaints') {
          <svg:path d="M0 136L20 131.1L40 127.1L60 124L80 121.8L100 120.4L120 120L140 120.4L160 121.8L180 124L200 127.1L220 131.1L240 136L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 136.3L1.4 135.7L20 131.1L26.7 129.8L0 145.7ZM58.8 124.2L24 160L0 160L44.4 126.4ZM82.2 121.6L72 160L48 160L71 122.8L80 121.8ZM92.6 120.9L100 120.4L102.5 120.4L120 160L96 160ZM168 160L144 160L112.4 120.2L120 120L122.2 120ZM192 160L132.4 120.3L140 120.4L143.1 120.7L216 160ZM240 150.6L240 160L154.9 121.4L160 121.8L168.7 122.7ZM200 127.1L213.3 129.8L240 137.9L240 143.5L185.8 124.9Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M78 34h84a10 10 0 0 1 10 10v40a10 10 0 0 1-10 10h-50l-18 16v-16H78a10 10 0 0 1-10-10V44a10 10 0 0 1 10-10z" [attr.style]="'fill: var(--c-surface); stroke: var(--c-ink)'" stroke-width="3" stroke-linejoin="round"></svg:path>
          <svg:path d="M92 56h56M92 72h36" [attr.style]="'fill: none; stroke: var(--c-straw)'" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></svg:path>
        }
      @case ('empty-fields') {
          <svg:path d="M0 120L20 115.1L40 111.1L60 108L80 105.8L100 104.4L120 104L140 104.4L160 105.8L180 108L200 111.1L220 115.1L240 120L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 120L20 115.1L26.6 113.8L0 126.3ZM58.9 108.2L0 145L0 134.3L44.6 110.4ZM82 105.6L24 160L0 160L71 106.8L80 105.8ZM92 105L100 104.4L101.6 104.4L72 160L48 160ZM110.9 104.2L120 104L120 160L96 160ZM138.4 104.4L168 160L144 160L129.1 104.2ZM148 105L158 105.6L216 160L192 160ZM181.1 108.2L240 145L240 160L169 106.8L180 108ZM200 111.1L213.4 113.8L240 126.3L240 134.3L195.4 110.4Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M58 95V111M140 92V107" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M58 94.5v5M140 91.5v5" [attr.style]="'fill: none; stroke: var(--c-straw)'" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M172 56V125" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M172 56l30 9-30 9z" [attr.style]="'fill: var(--c-straw)'"></svg:path>
        }
      @case ('empty-lab') {
          <svg:path d="M0 134L20 129.1L40 125.1L60 122L80 119.8L100 118.4L120 118L140 118.4L160 119.8L180 122L200 125.1L220 129.1L240 134L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 137.3L14.4 130.5L20 129.1L36.6 125.8L0 146.5ZM24 160L0 160L52.7 123.1L60 122L66 121.3ZM77.7 120L80 119.8L88.3 119.2L72 160L48 160ZM98.4 118.6L100 118.4L108.1 118.3L120 160L96 160ZM168 160L144 160L117.6 118.1L120 118L127.4 118.2ZM192 160L137.3 118.4L140 118.4L148 119L216 160ZM240 149.8L240 160L159.5 119.7L160 119.8L173.2 121.2ZM200 125.1L216.1 128.3L240 136.2L240 142.1L190.2 123.6Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M110 34v26l-26 50a8 8 0 0 0 7 12h58a8 8 0 0 0 7-12l-26-50V34" [attr.style]="'fill: var(--c-surface); stroke: var(--c-ink)'" stroke-width="3" stroke-linejoin="round"></svg:path>
          <svg:path d="M104 34h32M96 96h7M102 84h7" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M112 112c3-6 13-6 16 0-3 5-13 5-16 0z" [attr.style]="'fill: var(--c-straw)'"></svg:path>
        }
      @case ('empty-notifications') {
          <svg:path d="M0 130L20 125.1L40 121.1L60 118L80 115.8L100 114.4L120 114L140 114.4L160 115.8L180 118L200 121.1L220 125.1L240 130L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 130L20 125.1L32 122.7L0 134.2ZM0 148.9L0 140.6L53.3 119L60 118L68.7 117ZM24 160L0 160L81.7 115.7L92.8 114.9ZM72 160L48 160L103.2 114.4L113 114.2ZM132 114.3L120 160L96 160L122.6 114.1ZM141.6 114.6L151.5 115.2L168 160L144 160ZM192 160L161.9 116L173.3 117.3L216 160ZM186 118.9L200 121.1L200.8 121.3L240 145.3L240 160ZM240 130L240 135.4L220.1 125.1Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:rect x="112" y="86" width="8" height="42" rx="1" [attr.style]="'fill: var(--c-ink)'"></svg:rect>
          <svg:path d="M82 88V72a16 16 0 0 1 16-16h40a16 16 0 0 1 16 16v16z" [attr.style]="'fill: var(--c-straw)'"></svg:path>
          <svg:path d="M98 57v30" [attr.style]="'fill: none; stroke: var(--c-surface)'" stroke-width="3" stroke-linecap="butt" stroke-linejoin="round"></svg:path>
          <svg:path d="M146 79h20" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:circle cx="146" cy="79" r="4" [attr.style]="'fill: var(--c-ink)'"></svg:circle>
        }
      @case ('empty-recalls') {
          <svg:path d="M0 128L20 123.1L40 119.1L60 116L80 113.8L100 112.4L120 112L140 112.4L160 113.8L180 116L200 119.1L220 123.1L240 128L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 128L20 123.1L22.4 122.6L0 131.5ZM59.1 116.1L0 147.3L0 138.3L43.6 118.5ZM82.6 113.6L24 160L0 160L71.5 114.7L80 113.8ZM92.6 112.9L100 112.4L102.1 112.4L72 160L48 160ZM111.1 112.2L120 112L120 160L96 160ZM137.9 112.4L168 160L144 160L128.9 112.2ZM147.4 112.9L157.4 113.6L216 160L192 160ZM180.9 116.1L240 147.3L240 160L168.5 114.7L180 116ZM200 119.1L217.6 122.6L240 131.5L240 138.3L196.4 118.5Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M96 56L116 96L104 128M108 56L118 96L112 128M120 56L120 96L120 128M132 56L122 96L128 128M144 56L124 96L136 128" [attr.style]="'fill: none; stroke: var(--c-straw)'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M96 38c5 5 5 14 0 19-5-5-5-14 0-19zM108 38c5 5 5 14 0 19-5-5-5-14 0-19zM120 38c5 5 5 14 0 19-5-5-5-14 0-19zM132 38c5 5 5 14 0 19-5-5-5-14 0-19zM144 38c5 5 5 14 0 19-5-5-5-14 0-19z" [attr.style]="'fill: var(--c-straw)'"></svg:path>
          <svg:path d="M108 96h24" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></svg:path>
        }
      @case ('empty-search') {
          <svg:path d="M0 128L20 123.1L40 119.1L60 116L80 113.8L100 112.4L120 112L140 112.4L160 113.8L180 116L200 119.1L220 123.1L240 128L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 130L0 128L11.6 125.2ZM0 137.1L36.3 119.8L40 119.1L53.3 117L0 146.7ZM67.2 115.2L79.4 113.8L24 160L0 160ZM90.2 113.1L100 112.4L100.5 112.4L72 160L48 160ZM110.3 112.2L120 112L120 160L96 160ZM139.5 112.4L168 160L144 160L129.7 112.2ZM216 160L192 160L149.8 113.1L160 113.8L160.6 113.8ZM186.7 117L240 146.7L240 160L172.8 115.2L180 116ZM203.7 119.8L220 123.1L228.4 125.2L240 130L240 137.1Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M146 102l24 24" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:circle cx="120" cy="76" r="34" [attr.style]="'fill: var(--c-surface); stroke: var(--c-ink)'" stroke-width="6" stroke-linejoin="round"></svg:circle>
          <svg:path d="M100 92l4-30M116 98l4-40M132 94l4-30" [attr.style]="'fill: none; stroke: var(--c-straw)'" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></svg:path>
        }
      @case ('empty-waybills') {
          <svg:path d="M0 132L20 127.1L40 123.1L60 120L80 117.8L100 116.4L120 116L140 116.4L160 117.8L180 120L200 123.1L220 127.1L240 132L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 132L20 127.1L36.7 123.8L0 136ZM0 149.8L0 142.1L58.3 120.3L60 120L73.6 118.5ZM24 160L0 160L86.5 117.3L97.9 116.6ZM72 160L48 160L108.3 116.3L118.3 116ZM137.7 116.4L120 160L96 160L128 116.2ZM147.5 116.9L157.7 117.6L168 160L144 160ZM180.4 120.1L216 160L192 160L168.6 118.7L180 120ZM194 122.2L200 123.1L210.4 125.2L240 144.4L240 160ZM240 132L240 134.3L232.3 130.1Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M92 30h56a6 6 0 0 1 6 6v68l-20 20H98a6 6 0 0 1-6-6z" [attr.style]="'fill: var(--c-surface); stroke: var(--c-ink)'" stroke-width="3" stroke-linejoin="round"></svg:path>
          <svg:path d="M154 104h-14a6 6 0 0 0-6 6v14M106 50h34M106 64h34M106 78h20" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:circle cx="114" cy="102" r="9" [attr.style]="'fill: var(--c-straw)'"></svg:circle>
        }
      @case ('forbidden') {
          <svg:path d="M0 126L20 121.1L40 117.1L60 114L80 111.8L100 110.4L120 110L140 110.4L160 111.8L180 114L200 117.1L220 121.1L240 126L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 129.3L0 126L17.8 121.7ZM0 136.6L39.8 117.2L40 117.1L55.6 114.7L0 146.3ZM80.5 111.7L24 160L0 160L68.7 113L80 111.8ZM91 111L100 110.4L101 110.4L72 160L48 160ZM110.6 110.2L120 110L120 160L96 160ZM139 110.4L168 160L144 160L129.4 110.2ZM149 111L159.5 111.7L216 160L192 160ZM184.4 114.7L240 146.3L240 160L171.3 113L180 114ZM200.2 117.2L220 121.1L222.2 121.7L240 129.3L240 136.6Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:rect x="54" y="60" width="10" height="68" rx="2" [attr.style]="'fill: var(--c-ink)'"></svg:rect>
          <svg:rect x="176" y="60" width="10" height="68" rx="2" [attr.style]="'fill: var(--c-ink)'"></svg:rect>
          <svg:path d="M64 72h112M64 90h112M64 108h112M68 106l104-32" [attr.style]="'fill: none; stroke: var(--c-straw)'" stroke-width="6" stroke-linecap="butt" stroke-linejoin="round"></svg:path>
          <svg:path d="M160 86v-6a6 6 0 0 1 12 0v6" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:rect x="155" y="85" width="22" height="17" rx="3" [attr.style]="'fill: var(--c-ink)'"></svg:rect>
          <svg:circle cx="166" cy="93.5" r="2.5" [attr.style]="'fill: var(--c-surface)'"></svg:circle>
        }
      @case ('login') {
          <svg:path d="M0 112L20 108.3L40 105.3L60 103L80 101.3L100 100.3L120 100L140 100.3L160 101.3L180 103L200 105.3L220 108.3L240 112L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 113L6.8 110.7L20 108.3L29.2 107L0 117.3ZM59.7 103L0 128.9L0 122.5L45.8 104.7ZM82.6 101.2L0 146.8L0 136.7L71.5 102L80 101.3ZM92.7 100.7L100 100.3L102.4 100.3L24 160L0 160ZM72 160L48 160L111.6 100.1L120 100L120.7 100ZM138.7 100.3L120 160L96 160L129.7 100.2ZM147.7 100.7L157 101.2L168 160L144 160ZM192 160L166.6 101.9L176.6 102.7L216 160ZM240 139.8L240 160L187.4 103.9L198.9 105.2ZM212 107.1L220 108.3L227 109.6L240 117.3L240 126.6Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M80 104V70l24-20 24 20V104z" [attr.style]="'fill: var(--c-clay)'"></svg:path>
          <svg:path d="M96 104V82h16V104M96 82l16 22M112 82l-16 22" [attr.style]="'fill: none; stroke: var(--c-surface)'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M134 104V60a11 11 0 0 1 22 0V104z" [attr.style]="'fill: var(--c-straw)'"></svg:path>
          <svg:path d="M134 72h22M134 86h22" [attr.style]="'fill: none; stroke: var(--c-surface)'" stroke-width="2.5" stroke-linecap="butt" stroke-linejoin="round"></svg:path>
        }
      @case ('not-found') {
          <svg:path d="M0 124L20 119.1L40 115.1L60 112L80 109.8L100 108.4L120 108L140 108.4L160 109.8L180 112L200 115.1L220 119.1L240 124L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 124.4L3.5 123.1L20 119.1L31.8 116.8L0 130ZM0 146.7L0 137.1L49.3 113.7L60 112L63 111.7ZM74.4 110.4L80 109.8L84.6 109.5L24 160L0 160ZM94 108.8L100 108.4L103 108.4L72 160L48 160ZM111.5 108.2L120 108L120 160L96 160ZM137 108.4L168 160L144 160L128.5 108.2ZM146 108.8L155.4 109.5L216 160L192 160ZM240 160L165.6 110.4L177 111.7L240 146.7ZM200 115.1L208.2 116.8L240 130L240 137.1L190.7 113.7Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:path d="M94 160c14-24 30-36 24-52h4c8 16-8 28 18 52z" [attr.style]="'fill: var(--c-surface)'"></svg:path>
          <svg:path d="M160 44V125.8" [attr.style]="'fill: none; stroke: var(--c-ink)'" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M160 50h32l8 8-8 8h-32z" [attr.style]="'fill: var(--c-straw)'"></svg:path>
          <svg:path d="M160 74h-32l-8 8 8 8h32z" [attr.style]="'fill: var(--c-straw)'"></svg:path>
        }
      @case ('recall-warning') {
          <svg:path d="M0 132L20 127.1L40 123.1L60 120L80 117.8L100 116.4L120 116L140 116.4L160 117.8L180 120L200 123.1L220 127.1L240 132L240 160L0 160Z" [attr.style]="'fill: var(--c-furrow-a)'"></svg:path>
          <svg:path d="M0 138.3L28.4 125.4L40 123.1L48.4 121.8L0 147.3ZM63.8 119.6L76.9 118.1L24 160L0 160ZM72 160L48 160L88.5 117.2L99.5 116.5ZM109.8 116.2L120 116L120 160L96 160ZM144 160L130.2 116.2L140 116.4L140.5 116.5L168 160ZM216 160L192 160L151.5 117.2L160 117.8L163.1 118.1ZM191.6 121.8L240 147.3L240 160L176.2 119.6L180 120ZM220 127.1L240 132L240 138.3L211.6 125.4Z" [attr.style]="'fill: var(--c-furrow-b)'"></svg:path>
          <svg:rect x="80" y="86" width="72" height="42" rx="4" [attr.style]="'fill: var(--c-straw)'"></svg:rect>
          <svg:path d="M80 100h72" [attr.style]="'fill: none; stroke: var(--c-surface)'" stroke-width="3" stroke-linecap="butt" stroke-linejoin="round"></svg:path>
          <svg:rect x="106" y="108" width="20" height="6" rx="3" [attr.style]="'fill: var(--c-surface)'"></svg:rect>
          <svg:path d="M152 104h14a18 18 0 0 0 18-18v-10a26 26 0 0 0-26-26h-24a18 18 0 0 0-18 18v6" [attr.style]="'fill: none; stroke: var(--c-clay)'" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"></svg:path>
          <svg:path d="M102 72l14 16 14-16z" [attr.style]="'fill: var(--c-clay)'"></svg:path>
        }
    }`,
})
export class IllustrationComponent {
  readonly art = input.required<IllustrationName>();
  protected readonly viewBox = computed(() => VIEW_BOX[this.art()]);
}
