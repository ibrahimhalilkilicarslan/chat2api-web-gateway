.PHONY: setup doctor dev lint typecheck test build audit check docker-build docker-smoke compose-config

setup:
	pnpm setup

doctor:
	pnpm doctor

dev:
	pnpm dev

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

build:
	pnpm build

audit:
	pnpm audit:prod

check:
	pnpm check

docker-build:
	docker build --tag chat2api-web-gateway:local .

docker-smoke:
	CHAT2API_SMOKE_IMAGE=chat2api-web-gateway:local pnpm smoke:container

compose-config:
	docker compose -f compose.yaml -f compose.local.yaml config
