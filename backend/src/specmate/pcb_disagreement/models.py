import uuid

from django.conf import settings
from django.db import models


class SourceNetAttempt(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_file = models.ForeignKey("sources.SourceBundleFile", on_delete=models.PROTECT)
    source_role = models.CharField(max_length=20)
    build = models.OneToOneField("builds.BuildAttempt", on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class SourceNetInterpretation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    attempt = models.OneToOneField(SourceNetAttempt, on_delete=models.PROTECT)
    output = models.OneToOneField(
        "builds.StageOutput", on_delete=models.PROTECT, related_name="source_net_report"
    )
    xml_output = models.OneToOneField(
        "builds.StageOutput", on_delete=models.PROTECT, related_name="source_net_xml"
    )
    canonical = models.BinaryField()
    sha256 = models.CharField(max_length=64)
    accepted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
