release:
	helm package charts/mint -d releases
	helm repo index --url https://mintproject.github.io/mint/ .