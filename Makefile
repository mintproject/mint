release:
	helm package helm -d releases
	helm repo index --url https://mintproject.github.io/mint/ .