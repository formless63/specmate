"""Fresh full closure precedes comparisons, history, inbox labels and pagination."""

import json
from functools import wraps

from specmate.access.models import Membership
from specmate.access.permissions import Perm, authorize
from specmate.catalog.discovery import WhereUsed, visible_page, where_used
from specmate.catalog_matching.queries import (
    authorize_file,
    current_actor,
    evidence_result,
    revision_identity,
)
from specmate.collaboration.contracts import CompareRevisions
from specmate.collaboration.models import ChangeReview, InternalNotification
from specmate.knowledge.queries import entry_result, get_item
from specmate.operations import NotFound, OperationError, ValidationFailed
from specmate.queries import get_revision
from specmate.revision_upgrades import queries as upgrades

MAX_ENTRIES = 500


def private_inputs(function):
    """Missing and forbidden references share one response, without existence hints."""

    @wraps(function)
    def guarded(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except NotFound:
            raise NotFound("Change review inputs unavailable.") from None

    return guarded


@private_inputs
def revision_pair(user, old_id, candidate_id):
    user = current_actor(user)
    return get_revision(user, old_id), get_revision(user, candidate_id)


def changed_facts(old, candidate, path=()):
    """Declared JSON paths, never feature correspondence. Missing and null differ."""
    if isinstance(old, dict) and isinstance(candidate, dict):
        for key in sorted(old.keys() | candidate.keys()):
            if key not in old:
                yield {
                    "path": [*path, key],
                    "change": "added",
                    "old_present": False,
                    "candidate_present": True,
                    "old": None,
                    "candidate": candidate[key],
                }
            elif key not in candidate:
                yield {
                    "path": [*path, key],
                    "change": "removed",
                    "old_present": True,
                    "candidate_present": False,
                    "old": old[key],
                    "candidate": None,
                }
            else:
                yield from changed_facts(old[key], candidate[key], (*path, key))
    elif isinstance(old, list) and isinstance(candidate, list):
        for index in range(max(len(old), len(candidate))):
            if index >= len(old) or index >= len(candidate):
                yield {
                    "path": [*path, index],
                    "change": "added" if index >= len(old) else "removed",
                    "old_present": index < len(old),
                    "candidate_present": index < len(candidate),
                    "old": old[index] if index < len(old) else None,
                    "candidate": candidate[index] if index < len(candidate) else None,
                }
            else:
                yield from changed_facts(old[index], candidate[index], (*path, index))
    elif type(old) is not type(candidate) or old != candidate:
        yield {
            "path": list(path),
            "change": "changed",
            "old_present": True,
            "candidate_present": True,
            "old": old,
            "candidate": candidate,
        }


def compare(user, payload):
    user = current_actor(user)
    old, candidate = revision_pair(user, payload.old_revision_id, payload.candidate_revision_id)
    left, right = [json.loads(bytes(r.snapshot.canonical))["content"] for r in (old, candidate)]
    changes = []
    for index, value in enumerate(changed_facts(left, right)):
        if index < payload.changes_offset:
            continue
        changes.append(value)
        if len(changes) > payload.changes_limit:
            break
    parent_revision = old if payload.parents_side == "old" else candidate
    parents = where_used(
        user,
        WhereUsed(
            revision_id=parent_revision.id, after=payload.parents_after, limit=payload.parents_limit
        ),
    )
    # Current closure is checked again after rendering derived values.
    revision_pair(user, old.id, candidate.id)
    return {
        "old": revision_identity(old).model_dump(mode="json"),
        "candidate": revision_identity(candidate).model_dump(mode="json"),
        "identity_relation": "same_definition"
        if old.definition_id == candidate.definition_id
        else "distinct_definitions",
        "changes": changes[: payload.changes_limit],
        "next_changes_offset": payload.changes_offset + payload.changes_limit
        if len(changes) > payload.changes_limit
        else None,
        "dependency_pins": {
            side: sorted(map(str, r.snapshot.dependencies.values_list("revision_id", flat=True)))
            for side, r in [("old", old), ("candidate", candidate)]
        },
        "parents": parents,
        "parents_side": payload.parents_side,
        "parent_scope": "currently_authorized_captured_snapshot_pins",
        "compatibility": "not_evaluated",
        "qualification": "not_evaluated",
        "correspondence": "not_evaluated",
        "limitations": [
            "JSON paths compare declared values, including unknowns; matching paths or labels "
            "do not establish feature correspondence.",
            "Parents are captured exact snapshot dependencies, not exhaustive physical, artifact "
            "or evidence impact. Hidden parents are omitted without counts.",
            "Comparison and team recommendations do not authorize adoption, release, "
            "distribution or physical qualification.",
        ],
    }


@private_inputs
def knowledge_pin(user, pin):
    if pin is None:
        return None
    item, entries, attachments = get_item(current_actor(user), pin.item_id)
    entry = next((e for e in entries if e.number == pin.entry_number), None)
    if entry is None:
        raise NotFound("Knowledge entry unavailable.")
    return entry, {"item_id": str(item.id), **entry_result(entry, attachments.get(entry.id, []))}


@private_inputs
def review_rows(user, review_id, permission=Perm.PROJECT_READ, *, lock=False):
    user = current_actor(user)
    query = ChangeReview.objects.select_related("knowledge_entry")
    if lock:
        query = query.select_for_update(of=("self",))
    review = query.filter(id=review_id).first()
    if review is None:
        raise NotFound("Change review unavailable.")
    authorize(user, review.project_id, permission)
    old, candidate = revision_pair(user, review.old_revision_id, review.candidate_revision_id)
    if review.knowledge_entry_id:
        get_item(user, review.knowledge_entry.item_id)
    entries = list(
        review.entries.select_related(
            "source_file__revision__bundle", "source_file__blob"
        ).order_by("number")[: MAX_ENTRIES + 1]
    )
    # All historic evidence/proposal closure precedes history and state diagnostics.
    for entry in entries:
        authorize_file(user, entry.source_file)
        if entry.upgrade_proposal_id:
            upgrades.rows(user, entry.upgrade_proposal_id)
    if len(entries) > MAX_ENTRIES:
        raise ValidationFailed("Review history exceeds the supported limit.")
    return review, old, candidate, entries


def status(entries):
    lifecycle = [e.action for e in entries if e.action in {"close", "reopen"}]
    return "closed" if lifecycle and lifecycle[-1] == "close" else "open"


def summary(user, review_id, *, permission=Perm.PROJECT_READ):
    user = current_actor(user)
    review, old, candidate, entries = review_rows(user, review_id, permission)
    members = dict(
        Membership.objects.filter(project_id=review.project_id, user__is_active=True).values_list(
            "user_id", "user__username"
        )
    )
    pinned = None
    if review.knowledge_entry_id:
        from specmate.collaboration.contracts import KnowledgePin

        pinned = knowledge_pin(
            user,
            KnowledgePin(
                item_id=review.knowledge_entry.item_id, entry_number=review.knowledge_entry.number
            ),
        )[1]
    return {
        "review_id": str(review.id),
        "project_id": str(review.project_id),
        "title": review.title,
        "old": revision_identity(old).model_dump(mode="json"),
        "candidate": revision_identity(candidate).model_dump(mode="json"),
        "state": review.state_token,
        "status": status(entries),
        "knowledge": pinned,
        "recipients": [
            {"user_id": str(r.user_id), "username": members[r.user_id]}
            for r in review.recipients.all()
            if r.user_id in members
        ],
        "entries": [
            {
                "entry_id": str(e.id),
                "number": e.number,
                "action": e.action,
                "basis": e.basis,
                "author": members.get(e.author_id, "Former collaborator"),
                "created_at": e.created_at.isoformat(),
                "evidence": evidence_result(e).model_dump(mode="json"),
                "upgrade_proposal_id": str(e.upgrade_proposal_id)
                if e.upgrade_proposal_id
                else None,
            }
            for e in entries
        ],
        "compatibility": "not_evaluated",
        "qualification": "not_evaluated",
        "release_approval": "not_evaluated",
        "adoption": "separate_reviewed_upgrade_operation_required",
    }


def inspect(user, review_id):
    result = summary(user, review_id)
    result["comparison"] = compare(
        user,
        CompareRevisions(
            old_revision_id=result["old"]["revision_id"],
            candidate_revision_id=result["candidate"]["revision_id"],
        ),
    )
    review_rows(user, review_id)
    return result


def project_reviews(user, payload):
    user = current_actor(user)
    authorize(user, payload.project_id, Perm.PROJECT_READ)
    query = ChangeReview.objects.filter(project_id=payload.project_id)

    def render(row):
        result = summary(user, row.id)
        return {"record_id": str(row.id), **result}

    return visible_page(query, payload, render)


@private_inputs
def notification_row(user, notification_id, *, lock=False):
    user = current_actor(user)
    query = InternalNotification.objects.select_related("entry__review")
    if lock:
        query = query.select_for_update(of=("self",))
    notification = query.filter(id=notification_id, recipient=user).first()
    if notification is None:
        raise NotFound("Notification unavailable.")
    review_rows(user, notification.entry.review_id)
    return notification


def notification_result(user, notification_id):
    notification = notification_row(user, notification_id)
    review = summary(user, notification.entry.review_id)
    return {
        "record_id": str(notification.id),
        "notification_id": str(notification.id),
        "review_id": review["review_id"],
        "title": review["title"],
        "old": review["old"],
        "candidate": review["candidate"],
        "entry_id": str(notification.entry_id),
        "action": notification.entry.action,
        "created_at": notification.created_at.isoformat(),
        "read_at": notification.read_at.isoformat() if notification.read_at else None,
        "state": notification.state_token,
        "delivery": "internal_application_only",
    }


def inbox(user, payload):
    user = current_actor(user)
    authorize(user, payload.project_id, Perm.PROJECT_READ)
    query = InternalNotification.objects.filter(
        recipient=user, entry__review__project_id=payload.project_id
    )
    if payload.unread_only:
        query = query.filter(read_at__isnull=True)
    return visible_page(query, payload, lambda row: notification_result(user, row.id))


def notify(entry, actor):
    """Atomic pointer creation for current readable recipients; never external delivery."""
    review = entry.review
    recipient_ids = {*review.recipients.values_list("user_id", flat=True), review.created_by_id} - {
        actor.pk
    }
    for membership in Membership.objects.select_related("user").filter(
        project_id=review.project_id, user_id__in=recipient_ids, user__is_active=True
    ):
        try:
            review_rows(membership.user, review.id)
        except OperationError:
            continue
        InternalNotification.objects.create(entry=entry, recipient=membership.user)
