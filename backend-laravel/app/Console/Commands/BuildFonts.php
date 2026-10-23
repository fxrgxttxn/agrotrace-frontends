<?php

namespace App\Console\Commands;

use App\Infrastructure\Pdf\LabelPdf;
use Illuminate\Console\Command;

/** `artisan agrotrace:fonts` — builds the TCPDF font files of the QR label (Dockerfile, at image build time). */
final class BuildFonts extends Command
{
    protected $signature = 'agrotrace:fonts';

    protected $description = 'Convert the label fonts (@fontsource WOFF) to TCPDF font files';

    public function handle(): int
    {
        $this->line(LabelPdf::fontDir());

        return self::SUCCESS;
    }
}
