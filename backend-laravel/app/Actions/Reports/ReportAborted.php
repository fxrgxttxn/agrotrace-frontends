<?php

namespace App\Actions\Reports;

use RuntimeException;

/** The client went away while its report waited for the renderer: nobody reads an answer (Express ReportAborted). */
final class ReportAborted extends RuntimeException {}
