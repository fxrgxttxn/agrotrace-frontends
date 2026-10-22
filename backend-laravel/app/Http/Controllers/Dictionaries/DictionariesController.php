<?php

namespace App\Http\Controllers\Dictionaries;

use App\Actions\Dictionaries\DictionariesActions;
use App\Actions\Dictionaries\DictionaryStore;
use App\Actions\Dictionaries\Import;
use App\Http\ClientConnection;
use App\Http\Multipart\MultipartReader;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Import\SheetReader;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /dictionaries/* (contracts/openapi/paths/dictionaries.yaml) and GET /public/regions (public.yaml): HTTP mapping of
 * DictionariesActions and the import. Path parameters are checked before the body (400), the guard before both.
 */
final class DictionariesController
{
    public function listDictionary(Request $request): Response
    {
        $name = DictionaryStore::nameParam($request);

        return Responses::json(DictionariesActions::list(Auth::principal(), $name, QueryReader::of($request)));
    }

    public function createDictionaryEntry(Request $request): Response
    {
        $name = DictionaryStore::nameParam($request);

        return Responses::json(DictionariesActions::create(Auth::principal(), $name, Responses::body($request)), 201);
    }

    public function updateDictionaryEntry(Request $request): Response
    {
        $name = DictionaryStore::nameParam($request);
        $id = Params::id($request);

        return Responses::json(DictionariesActions::update(Auth::principal(), $name, $id, Responses::body($request)));
    }

    public function deleteDictionaryEntry(Request $request): Response
    {
        $name = DictionaryStore::nameParam($request);
        $id = Params::id($request);
        DictionariesActions::remove(Auth::principal(), $name, $id);

        return Responses::noContent();
    }

    /** The file is read (CSV on this thread, XLSX in the sandbox) holding no DB slot (P61), then applied. */
    public function importDictionary(Request $request): Response
    {
        $name = DictionaryStore::nameParam($request);
        $upload = MultipartReader::read($request, Import::MAX_BYTES);
        SlotHolder::release();
        $gone = ClientConnection::watcher($request);
        $sheet = SheetReader::read($upload->bytes, count(Import::COLUMNS[$name]), $gone);

        return Responses::json(Import::apply($name, $sheet, Auth::principal()->userId, $gone));
    }

    public function uploadProductImage(Request $request): Response
    {
        $id = Params::id($request);
        $upload = MultipartReader::read($request, DictionariesActions::PRODUCT_IMAGE_MAX_BYTES);

        return Responses::json(DictionariesActions::uploadImage(Auth::principal(), $id, $upload));
    }

    public function listPublicRegions(): Response
    {
        return Responses::json(DictionariesActions::publicRegions());
    }
}
