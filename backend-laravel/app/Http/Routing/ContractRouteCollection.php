<?php

namespace App\Http\Routing;

use App\Contract\RouteMatch;
use Illuminate\Http\Request;
use Illuminate\Routing\RouteCollection;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * ONE router decides the operation (review I1): the route that runs is the route named by ContractGate's
 * RouteMatch::operationId, with the parameters ContractGate decoded from the RAW path — never Laravel's own match on
 * the decoded path. Laravel would read `/fields/<id>%2Ftreatments` as listTreatments and `…/imp%6Frt` as `import`,
 * and pick routes by registration order; Express (and ContractGate) take getField with id `<id>/treatments`, a
 * literal segment only when it is written literally, the literal template before a parameter one. A declared
 * operation without a route yet is 404. Requests ContractGate did not match (Swagger UI) use Laravel's matching.
 */
final class ContractRouteCollection extends RouteCollection
{
    public function match(Request $request)
    {
        $match = $request->attributes->get(RouteMatch::class);
        if (! $match instanceof RouteMatch) {
            return parent::match($request);
        }
        $route = $this->getByName($match->operationId);
        if ($route === null) {
            // A route named after it was added (->name() after Route::get) is only in the lookup after a refresh.
            $this->refreshNameLookups();
            $route = $this->getByName($match->operationId);
        }
        $method = $request->getMethod() === 'HEAD' ? 'GET' : $request->getMethod();
        if ($route === null || ! in_array($method, $route->methods(), true)) {
            throw new NotFoundHttpException;
        }
        $route->bind($request);
        foreach ($route->parameterNames() as $name) {
            $route->forgetParameter($name);
        }
        foreach ($match->params as $name => $value) {
            $route->setParameter($name, $value);
        }

        return $route;
    }
}
