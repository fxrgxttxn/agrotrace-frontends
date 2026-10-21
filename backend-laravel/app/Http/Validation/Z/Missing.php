<?php

namespace App\Http\Validation\Z;

/** JavaScript `undefined`: a property absent from the JSON object (null is a value, absence is not). */
enum Missing
{
    case Undefined;
}
