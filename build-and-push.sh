#!/usr/bin/env bash

set -x
set -e

TIMESTAMP=$(date +%s)
VERSION=$(git describe --always --abbrev --dirty="-dirty-${TIMESTAMP}")
NAME=web
IMAGE=registry.pumpking.aleksandr.vin/dives/"${NAME}"

docker-buildx build --progress plain -t "${NAME}:${VERSION}" --platform=linux/amd64 .
for image_tag in \
  "${NAME}":dev \
  "${IMAGE}":dev \
  "${IMAGE}:${VERSION}"
do
  docker tag "${NAME}:${VERSION}" "${image_tag}"
  [[ "${image_tag}" =~ "${IMAGE}" ]] && docker push "${image_tag}"
done

helm upgrade --install -f dev-values.yaml "${NAME}" ./helm-charts \
  --set image.tag="${VERSION}" \
  --set deploymentId="${VERSION}"
