release:
	helm package helm -d charts
	helm repo index --url https://mintproject.github.io/mint/ .