<?php

namespace App\Infrastructure\Pdf;

use RuntimeException;

/**
 * WOFF 1.0 → the sfnt (TrueType/OpenType) font it wraps (W3C WOFF File Format 1.0): the design-system fonts ship as
 * the @fontsource WOFF files (Express and Django embed the same ones), TCPDF reads TrueType. Each table is zlib-
 * compressed when its compLength < origLength; the sfnt gets a fresh table directory with the original checksums.
 */
final class Woff
{
    public static function toSfnt(string $woff): string
    {
        if (strlen($woff) < 44 || substr($woff, 0, 4) !== 'wOFF') {
            throw new RuntimeException('not a WOFF 1.0 font');
        }
        $flavor = substr($woff, 4, 4);
        $numTables = unpack('n', $woff, 12)[1];
        $entries = [];
        for ($i = 0; $i < $numTables; $i++) {
            $e = unpack('a4tag/Noffset/NcompLength/NorigLength/NorigChecksum', $woff, 44 + 20 * $i);
            $data = substr($woff, $e['offset'], $e['compLength']);
            if ($e['compLength'] < $e['origLength']) {
                $data = @gzuncompress($data);
                if ($data === false) {
                    throw new RuntimeException("WOFF table {$e['tag']} does not inflate");
                }
            }
            if (strlen($data) !== $e['origLength']) {
                throw new RuntimeException("WOFF table {$e['tag']} has the wrong length");
            }
            $entries[] = ['tag' => $e['tag'], 'checksum' => $e['origChecksum'], 'data' => $data];
        }
        usort($entries, fn ($a, $b) => strcmp($a['tag'], $b['tag']));
        $pow = 1;
        $log = 0;
        while ($pow * 2 <= $numTables) {
            $pow *= 2;
            $log++;
        }
        $out = $flavor.pack('nnnn', $numTables, $pow * 16, $log, $numTables * 16 - $pow * 16);
        $offset = 12 + 16 * $numTables;
        $body = '';
        foreach ($entries as $e) {
            $len = strlen($e['data']);
            $out .= $e['tag'].pack('NNN', $e['checksum'], $offset, $len);
            $padded = $e['data'].str_repeat("\0", (4 - $len % 4) % 4);
            $body .= $padded;
            $offset += strlen($padded);
        }

        return $out.$body;
    }
}
