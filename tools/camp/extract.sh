#!/bin/sh
# Nattplass (free overnight spots): cut a Geofabrik country extract into small theme files for build.py.
# Usage: tools/camp/extract.sh norway [theme]   (one theme only when given; needs cache/<country>-latest.osm.pbf and osmium-tool)
set -e
C=$1; T=$2; D=$(dirname "$0")/cache; P=$D/$C-latest.osm.pbf; O=$D/$C; mkdir -p $O
f() { [ -n "$T" ] && [ "$T" != "$1" ] && return 0; osmium tags-filter -O --no-progress -o $O/$1.osm.pbf $P $2 >/dev/null; osmium export -O -f geojsonseq -x print_record_separator=false --geometry-types=$3 -a type,id -o $O/$1.geojsonl $O/$1.osm.pbf; rm $O/$1.osm.pbf; echo "$C $1 $(wc -l < $O/$1.geojsonl)"; }
f roads    'w/route=ferry w/highway=motorway,trunk,primary,secondary,tertiary,unclassified,residential,service,track,motorway_link,trunk_link,primary_link,secondary_link,tertiary_link,living_street,road' linestring
f water    'wr/natural=water wr/water wr/landuse=reservoir w/natural=coastline w/waterway=river,canal' linestring,polygon
f cover    'wr/landuse=forest wr/natural=wood,heath,scrub,wetland,bare_rock,grassland,moor,fell wr/landuse=farmland,meadow,residential,industrial,quarry,military' polygon
f build    'wr/building' point,polygon
f places   'n/place=city,town,village,hamlet,isolated_dwelling' point
f pois     'nwr/amenity=parking,picnic_site,shelter,toilets,drinking_water,bbq,fuel nwr/tourism=camp_site,caravan_site,viewpoint,picnic_site,wilderness_hut,alpine_hut nwr/leisure=firepit,picnic_table,beach_resort nwr/natural=beach nwr/highway=rest_area,turning_circle,turning_loop,passing_place nwr/leisure=slipway,bathing_place,fishing' point,polygon
f svc      'nwr/shop=supermarket,convenience,general,grocery,food nwr/amenity=fuel,charging_station' point,polygon
f barriers 'nw/barrier' point,linestring
f protect  'wr/boundary=protected_area,national_park wr/leisure=nature_reserve' polygon
