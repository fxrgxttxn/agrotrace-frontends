#!/usr/bin/env python
"""Django's command-line utility. Migrations are never run (the schema is dbmate's, db/migrations)."""
import os
import sys

if __name__ == "__main__":
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agrotrace.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)
