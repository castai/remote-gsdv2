{{- $fullName := printf "gsd-%s" (required ".Values.projectName is required" .Values.projectName) -}}
{{- define "gsd-remote.fullname" -}}
gsd-{{ required ".Values.projectName is required" .Values.projectName }}
{{- end -}}
{{- define "gsd-remote.labels" -}}
app.kubernetes.io/name: gsd-remote
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
gsd/project: {{ .Values.projectName }}
{{- end -}}
{{- define "gsd-remote.selectorLabels" -}}
app.kubernetes.io/name: gsd-remote
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
