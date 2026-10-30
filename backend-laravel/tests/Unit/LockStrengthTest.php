<?php

/*
 * Lock strengths (P57, plan Global Constraints): explicit row locks are `FOR NO KEY UPDATE`; `FOR UPDATE` only for the
 * hard delete of a dictionary row (DictionaryStore) and in deleteField (FieldsActions::remove through Locks::field);
 * Eloquent's lockForUpdate() never. `FOR KEY SHARE`, `FOR SHARE` and sharedLock() are allowed. Code only — comments
 * are not scanned.
 */

use Tests\Support\SourceScan;
use Tests\TestCase;

uses(TestCase::class);

/** @return list<string> "file:line text" of every string literal that says FOR UPDATE, and of every lockForUpdate( */
function forUpdateSites(): array
{
    $out = [];
    foreach (SourceScan::appFiles() as $file) {
        $tokens = SourceScan::code($file);
        foreach ($tokens as $i => $t) {
            if ($t->is(T_STRING) && $t->text === 'lockForUpdate' && ($tokens[$i + 1]->text ?? '') === '(') {
                $out[] = "{$file}: lockForUpdate(";
            }
            if ($t->is([T_CONSTANT_ENCAPSED_STRING, T_ENCAPSED_AND_WHITESPACE]) && preg_match('/\bfor\s+update\b/i', $t->text)) {
                $out[] = "{$file}: ".trim(preg_replace('/\s+/', ' ', $t->text));
            }
        }
    }

    return $out;
}

it('allows FOR UPDATE only for the dictionary hard delete and deleteField, and no lockForUpdate()', function () {
    expect(forUpdateSites())->toBe([
        // DictionaryStore::select($name, $id, 'delete') — the hard delete of a dictionary row.
        "app/Actions/Dictionaries/DictionaryStore.php: ' FOR UPDATE'",
        // FieldsActions::remove — deleteField locks its field FOR UPDATE.
        "app/Actions/Fields/FieldsActions.php: 'for update'",
        // Locks::field's allowed strengths (the one caller with 'for update' is the line above).
        "app/Infrastructure/Db/Locks.php: 'for update'",
    ]);
});

it('finds the patterns it guards against (the scan itself works)', function () {
    $tokens = PhpToken::tokenize('<?php DB::table("x")->lockForUpdate()->get(); DB::select("SELECT 1 FOR  UPDATE");');
    $strings = array_filter($tokens, fn ($t) => $t->is(T_CONSTANT_ENCAPSED_STRING) && preg_match('/\bfor\s+update\b/i', $t->text));
    $calls = array_filter($tokens, fn ($t) => $t->is(T_STRING) && $t->text === 'lockForUpdate');
    expect(count($strings))->toBe(1)->and(count($calls))->toBe(1);
    expect(preg_match('/\bfor\s+update\b/i', 'FOR NO KEY UPDATE'))->toBe(0);
});

it('Locks::field takes FOR UPDATE only from deleteField', function () {
    $callers = [];
    foreach (SourceScan::appFiles() as $file) {
        $src = (string) file_get_contents(base_path($file));
        if (preg_match_all("/(?:ownField|Locks::field)\\([^;]*'for update'/", $src, $m)) {
            $callers[$file] = count($m[0]);
        }
    }
    expect($callers)->toBe(['app/Actions/Fields/FieldsActions.php' => 1]);
    $fields = (string) file_get_contents(base_path('app/Actions/Fields/FieldsActions.php'));
    expect($fields)->toMatch("/function remove\\(Principal \\\$p, string \\\$id\\): void\\s*\\{\\s*Tx::run\\(function \\(\\) use \\(\\\$p, \\\$id\\): void \\{\\s*self::ownField\\(\\\$p, \\\$id, 'for update'\\);/");
});
