<?php

namespace App\Http\Controllers\Fields;

use App\Actions\Fields\FieldsActions;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /fields/*, /treatments/{id} (contracts/openapi/paths/fields.yaml, treatments.yaml): HTTP mapping of FieldsActions. */
final class FieldsController
{
    public function listFields(Request $request): Response
    {
        return Responses::json(FieldsActions::list(Auth::principal(), QueryReader::of($request)));
    }

    public function createField(Request $request): Response
    {
        return Responses::json(FieldsActions::create(Auth::principal(), Responses::body($request)), 201);
    }

    public function getField(Request $request): Response
    {
        return Responses::json(FieldsActions::get(Auth::principal(), Params::id($request)));
    }

    public function updateField(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(FieldsActions::update(Auth::principal(), $id, Responses::body($request)));
    }

    public function deleteField(Request $request): Response
    {
        FieldsActions::remove(Auth::principal(), Params::id($request));

        return Responses::noContent();
    }

    public function listFieldTreatments(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(FieldsActions::listTreatments(Auth::principal(), $id, QueryReader::of($request)));
    }

    public function createTreatment(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(FieldsActions::createTreatment(Auth::principal(), $id, Responses::body($request)), 201);
    }

    public function updateTreatment(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(FieldsActions::updateTreatment(Auth::principal(), $id, Responses::body($request)));
    }
}
