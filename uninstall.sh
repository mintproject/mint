helm uninstall mint -n mint
kubectl delete pvc --all  -n mint
kubectl delete jobs --all -n mint
