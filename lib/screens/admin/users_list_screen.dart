import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:csv/csv.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';

class UsersListScreen extends StatefulWidget {
  final List<dynamic> users;
  const UsersListScreen({super.key, required this.users});

  @override
  State<UsersListScreen> createState() => _UsersListScreenState();
}

class _UsersListScreenState extends State<UsersListScreen> {
  final ApiService _apiService = ApiService();
  Set<String> _selectedUsers = {};
  bool _isLoading = false;

  Future<void> _importCSV() async {
    FilePickerResult? pickedFile = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['csv'],
    );

    if (pickedFile != null) {
      File file = File(pickedFile.files.single.path!);
      String csvString = await file.readAsString();
      List<List<dynamic>> rows = const CsvToListConverter().convert(csvString);

      List<Map<String, dynamic>> usersToImport = [];
      // Skip header row (index 0)
      for (int i = 1; i < rows.length; i++) {
        if (rows[i].length >= 5) {
          usersToImport.add({
            'name': rows[i][1],
            'email': rows[i][2],
            'password': rows[i][3] ?? 'default123',
            'department': rows[i][4],
            'role': rows[i].length > 5 ? rows[i][5] : 'user',
          });
        }
      }

      setState(() => _isLoading = true);
      final importResult = await _apiService.bulkImportUsers(usersToImport);
      setState(() => _isLoading = false);

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(importResult['message'] ?? 'Import complete'),
          backgroundColor: AppColors.success,
        ),
      );
    }
  }

  Future<void> _exportCSV() async {
    setState(() => _isLoading = true);
    final csvData = await _apiService.exportUsers();
    setState(() => _isLoading = false);

    if (csvData != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
              'Export successful! (Check backend logs or implement file save)'),
          backgroundColor: AppColors.success,
        ),
      );
    }
  }

  Future<void> _deleteSelected() async {
    if (_selectedUsers.isEmpty) return;

    setState(() => _isLoading = true);
    final deleteResult = await _apiService.deleteUsers(_selectedUsers.toList());
    setState(() => _isLoading = false);

    if (!mounted) return;
    if (deleteResult['success'] == true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(deleteResult['message']),
          backgroundColor: AppColors.success,
        ),
      );
      // Refresh list
      // widget.onRefresh();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(deleteResult['message']),
          backgroundColor: AppColors.danger,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('USER MANAGEMENT'),
        backgroundColor: AppColors.neonBlue.withOpacity(0.2),
        actions: [
          IconButton(
            icon: const Icon(Icons.upload_file),
            onPressed: _importCSV,
            tooltip: 'Import CSV',
          ),
          IconButton(
            icon: const Icon(Icons.download),
            onPressed: _exportCSV,
            tooltip: 'Export CSV',
          ),
          if (_selectedUsers.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.delete, color: AppColors.danger),
              onPressed: _deleteSelected,
            ),
        ],
      ),
      body: _isLoading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.neonCyan))
          : ListView.builder(
              padding: const EdgeInsets.all(20),
              itemCount: widget.users.length,
              itemBuilder: (context, index) {
                final user = widget.users[index];
                final isSelected = _selectedUsers.contains(user['userId']);
                return CheckboxListTile(
                  value: isSelected,
                  onChanged: (val) {
                    setState(() {
                      if (val!)
                        _selectedUsers.add(user['userId']);
                      else
                        _selectedUsers.remove(user['userId']);
                    });
                  },
                  title: Text(
                    user['name'] ?? 'Unknown',
                    style: const TextStyle(color: AppColors.textPrimary),
                  ),
                  subtitle: Text(
                    user['email'] ?? '',
                    style: TextStyle(color: AppColors.textSecondary),
                  ),
                  activeColor: AppColors.danger,
                  checkColor: AppColors.bgDark,
                );
              },
            ),
    );
  }
}
