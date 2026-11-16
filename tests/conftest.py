import os
import tempfile

# Отдельная временная база для тестов.
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(prefix="ct_test_"), "test.db")
