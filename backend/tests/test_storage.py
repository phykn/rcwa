import threading

from api.storage import ProjectStore


def test_concurrent_saves_of_one_job_return_one_record(tmp_path):
    store = ProjectStore(f"sqlite:///{tmp_path}/store.db")
    barrier, saved, errors = threading.Barrier(8), [], []

    def save():
        barrier.wait()
        try:
            saved.append(store.save({"name": "x"}, None, provenance={"job_id": "job-1"})["id"])
        except Exception as exc:  # pragma: no cover - the failure being guarded against
            errors.append(exc)

    threads = [threading.Thread(target=save) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == [] and len(saved) == 8 and len(set(saved)) == 1
    assert [record["id"] for record in store.list()] == saved[:1]
